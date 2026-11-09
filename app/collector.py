"""Collecting data from all clients, with progress tracking and load protection.

Protection layers (all tuneable in Settings):
1. Throttle: one request at a time per site, a pause between requests, a cap on parallel
   requests and request rate for the whole optmzr.ru domain (throttle.py).
2. Retries only on temporary errors, with growing pauses; Retry-After / 429 pause the domain.
3. Circuit breaker: if several clients in a row hit server errors, the run pauses, and if the
   server is still struggling the rest of that domain is skipped until the next run.
4. Cooldown: a client that was collected successfully a few minutes ago is not re-collected.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime
from urllib.parse import urlsplit

import httpx

from . import db
from .crypto import decrypt
from .optimizer import OptimizerClient, OptimizerError, ServerBusyError
from .throttle import Throttle, ThrottleConfig, domain_of

log = logging.getLogger("collector")


def adb(fn, *args):
    """Run a (blocking, network) database call without stalling the event loop."""
    return asyncio.to_thread(fn, *args)

DOMAIN_FAILS_TO_PAUSE = 2      # consecutive "server busy" clients before a pause
DOMAIN_PAUSE_SECONDS = 60
DOMAIN_FAILS_TO_STOP = 4       # ... and before giving up on the domain for this run


class CooldownError(OptimizerError):
    pass


@dataclass
class SyncState:
    running: bool = False
    total: int = 0
    done: int = 0
    failed: int = 0
    skipped: int = 0
    requests: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    trigger: str | None = None  # "manual" | "schedule"
    note: str | None = None     # e.g. "Пауза 60 с: сервер отвечает ошибками"
    active: list[int] = field(default_factory=list)


class Collector:
    def __init__(self) -> None:
        self.state = SyncState()
        self.throttle = Throttle()
        self._http: httpx.AsyncClient | None = None
        self._client_locks: dict[int, asyncio.Lock] = {}
        self._run_lock = asyncio.Lock()

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                headers={"User-Agent": "OptimizerDashboard/1.0 (internal KPI collector)",
                         "Accept": "application/json"},
                follow_redirects=True,
                limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
            )
        return self._http

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()

    def status(self) -> dict:
        return asdict(self.state)

    async def _apply_settings(self) -> dict:
        s = await adb(db.get_settings)
        self.throttle.configure(ThrottleConfig(
            host_interval=max(0.2, int(s.get("request_interval_ms") or 700) / 1000),
            domain_interval=0.3,
            domain_parallel=max(1, min(5, int(s.get("concurrency") or 2))),
        ))
        return s

    def _client(self, base_url: str, login: str, password: str) -> OptimizerClient:
        return OptimizerClient(base_url, login, password, self.http, self.throttle)

    async def test_connection(self, base_url: str, login: str, password: str) -> dict:
        await self._apply_settings()
        client = self._client(base_url, login, password)
        user = await client.login()
        branches = await client.branches()
        period = await client.default_period()
        return {
            "base_url": client.base_url,
            "user": user.get("full_name") or user.get("email"),
            "role": user.get("role"),
            "period": period,
            "branches": [b["name"] for b in branches],
        }

    @staticmethod
    def _fresh(row: dict, cooldown_min: int) -> float | None:
        """Minutes since the last successful collection if it is within the cooldown."""
        if not cooldown_min or row["last_status"] != "ok" or not row["last_sync_at"]:
            return None
        last = row["last_sync_at"]
        if isinstance(last, str):
            last = datetime.fromisoformat(last)
        ago = (datetime.now().astimezone() - last).total_seconds() / 60
        return ago if ago < cooldown_min else None

    async def sync_client(self, client_id: int, respect_cooldown: bool = True) -> dict:
        settings = await self._apply_settings()
        lock = self._client_locks.setdefault(client_id, asyncio.Lock())
        async with lock:
            row = await adb(db.query_one, "SELECT * FROM app.clients WHERE id = %s", (client_id,))
            if not row:
                raise OptimizerError("Клиент не найден")
            cooldown = int(settings.get("cooldown_min") or 0)
            ago = self._fresh(row, cooldown) if respect_cooldown else None
            if ago is not None:
                wait = max(1, round(cooldown - ago))
                raise CooldownError(f"Данные обновлялись {round(ago)} мин назад. Повторно — через {wait} мин "
                                    f"(защита от лишней нагрузки на сайт)")
            self.state.active.append(client_id)
            await adb(db.execute, "UPDATE app.clients SET last_status = 'running' WHERE id = %s", (client_id,))
            try:
                client = self._client(row["base_url"], row["login"], decrypt(row["password_enc"]))
                res = await client.collect()
                await adb(db.save_snapshot, client_id, res.period, res.source_updated_at,
                          res.kpi, res.branches, res.progress)
                await adb(db.execute,
                          "UPDATE app.clients SET last_status = 'ok', last_error = NULL, last_sync_at = %s WHERE id = %s",
                          (db.now(), client_id))
                return {"ok": True}
            except Exception as exc:  # noqa: BLE001 - every failure is reported to the UI
                msg = str(exc) if isinstance(exc, OptimizerError) else f"{type(exc).__name__}: {exc}"
                log.warning("sync %s failed: %s", client_id, msg)
                await adb(db.execute,
                          "UPDATE app.clients SET last_status = 'error', last_error = %s, last_sync_at = %s WHERE id = %s",
                          (msg, db.now(), client_id))
                return {"ok": False, "error": msg, "busy": isinstance(exc, ServerBusyError)}
            finally:
                if client_id in self.state.active:
                    self.state.active.remove(client_id)

    async def sync_all(self, trigger: str = "manual") -> None:
        if self._run_lock.locked():
            return
        async with self._run_lock:
            settings = await self._apply_settings()
            cooldown = int(settings.get("cooldown_min") or 0)
            rows = await adb(db.query, "SELECT * FROM app.clients WHERE enabled ORDER BY name")
            self.state = SyncState(running=True, total=len(rows), started_at=db.now_iso(), trigger=trigger)
            requests_before = self.throttle.requests_sent

            todo = []
            for r in rows:
                if self._fresh(r, cooldown) is not None:
                    self.state.done += 1
                    self.state.skipped += 1
                else:
                    todo.append(r)

            # Clients of one domain share a queue; a struggling domain can be paused/stopped
            # without affecting the others.
            by_domain: dict[str, list[dict]] = {}
            for r in todo:
                by_domain.setdefault(domain_of(urlsplit(r["base_url"]).netloc), []).append(r)

            parallel = max(1, min(5, int(settings.get("concurrency") or 2)))

            async def run_domain(domain: str, queue: list[dict]) -> None:
                fails = 0
                stopped = False
                lock = asyncio.Lock()

                async def worker() -> None:
                    nonlocal fails, stopped
                    while True:
                        async with lock:
                            if not queue:
                                return
                            row = queue.pop(0)
                        if stopped:
                            await adb(db.execute,
                                      "UPDATE app.clients SET last_status = 'error', last_error = %s, last_sync_at = %s "
                                      "WHERE id = %s",
                                      ("Пропущен: сервер Оптимайзера перегружен, повторим при следующем сборе",
                                       db.now(), row["id"]))
                            self.state.done += 1
                            self.state.failed += 1
                            continue
                        result = await self.sync_client(row["id"], respect_cooldown=False)
                        self.state.done += 1
                        self.state.requests = self.throttle.requests_sent - requests_before
                        if result["ok"]:
                            fails = 0
                            continue
                        self.state.failed += 1
                        if not result.get("busy"):
                            continue
                        fails += 1
                        if fails >= DOMAIN_FAILS_TO_STOP:
                            stopped = True
                            self.state.note = f"{domain}: сервер не справляется — остальные клиенты пропущены"
                            log.warning(self.state.note)
                        elif fails >= DOMAIN_FAILS_TO_PAUSE:
                            self.state.note = f"{domain}: сервер отвечает ошибками — пауза {DOMAIN_PAUSE_SECONDS} с"
                            log.warning(self.state.note)
                            self.throttle.cool_down(domain, DOMAIN_PAUSE_SECONDS)

                await asyncio.gather(*(worker() for _ in range(parallel)))

            try:
                await asyncio.gather(*(run_domain(d, q) for d, q in by_domain.items()))
            finally:
                self.state.requests = self.throttle.requests_sent - requests_before
                self.state.running = False
                self.state.finished_at = db.now_iso()
                try:
                    removed = await adb(db.prune_snapshots, int(settings.get("snapshot_retention_days") or 7))
                    if removed:
                        log.info("pruned %s old snapshots", removed)
                except Exception:  # noqa: BLE001
                    log.exception("snapshot pruning failed")


collector = Collector()
