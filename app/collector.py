"""Collecting data from all clients, with progress tracking."""
from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field

import httpx

from . import db
from .crypto import decrypt
from .optimizer import OptimizerClient, OptimizerError

log = logging.getLogger("collector")


@dataclass
class SyncState:
    running: bool = False
    total: int = 0
    done: int = 0
    failed: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    trigger: str | None = None  # "manual" | "schedule"
    active: list[int] = field(default_factory=list)


class Collector:
    def __init__(self) -> None:
        self.state = SyncState()
        self._http: httpx.AsyncClient | None = None
        self._client_locks: dict[int, asyncio.Lock] = {}
        self._run_lock = asyncio.Lock()

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(
                headers={"User-Agent": "OptimizerDashboard/1.0", "Accept": "application/json"},
                follow_redirects=True,
                limits=httpx.Limits(max_connections=50),
            )
        return self._http

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()

    def status(self) -> dict:
        return asdict(self.state)

    async def test_connection(self, base_url: str, login: str, password: str) -> dict:
        client = OptimizerClient(base_url, login, password, self.http)
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

    async def sync_client(self, client_id: int) -> dict:
        lock = self._client_locks.setdefault(client_id, asyncio.Lock())
        async with lock:
            row = db.query_one("SELECT * FROM clients WHERE id = ?", (client_id,))
            if not row:
                raise OptimizerError("Клиент не найден")
            self.state.active.append(client_id)
            db.execute("UPDATE clients SET last_status = 'running' WHERE id = ?", (client_id,))
            try:
                client = OptimizerClient(row["base_url"], row["login"], decrypt(row["password_enc"]), self.http)
                res = await client.collect()
                db.save_snapshot(client_id, res.period, res.source_updated_at, res.kpi, res.branches)
                db.execute(
                    "UPDATE clients SET last_status = 'ok', last_error = NULL, last_sync_at = ? WHERE id = ?",
                    (db.now_iso(), client_id),
                )
                return {"ok": True}
            except Exception as exc:  # noqa: BLE001 - every failure is reported to the UI
                msg = str(exc) if isinstance(exc, OptimizerError) else f"{type(exc).__name__}: {exc}"
                log.warning("sync %s failed: %s", client_id, msg)
                db.execute(
                    "UPDATE clients SET last_status = 'error', last_error = ?, last_sync_at = ? WHERE id = ?",
                    (msg, db.now_iso(), client_id),
                )
                return {"ok": False, "error": msg}
            finally:
                if client_id in self.state.active:
                    self.state.active.remove(client_id)

    async def sync_all(self, trigger: str = "manual") -> None:
        if self._run_lock.locked():
            return
        async with self._run_lock:
            ids = [r["id"] for r in db.query("SELECT id FROM clients WHERE enabled = 1 ORDER BY name")]
            self.state = SyncState(running=True, total=len(ids), started_at=db.now_iso(), trigger=trigger)
            sem = asyncio.Semaphore(max(1, int(db.get_settings().get("concurrency") or 5)))

            async def one(cid: int) -> None:
                async with sem:
                    result = await self.sync_client(cid)
                self.state.done += 1
                if not result["ok"]:
                    self.state.failed += 1

            try:
                await asyncio.gather(*(one(i) for i in ids))
            finally:
                self.state.running = False
                self.state.finished_at = db.now_iso()


collector = Collector()
