"""Client for an Optimizer site (https://<client>.optmzr.ru).

The site's frontend talks to a JSON API under /summary_api:
  POST /summary_api/api/auth/login   {"email": <login>, "password": ...} -> {"access_token": ...}
  GET  /summary_api/api/default-period                 -> {"period": "YYYY-MM"}
  GET  /summary_api/api/branches                       -> [{"id", "name", "is_active", ...}]
  GET  /summary_api/api/kpi?period=..&branch_guids=..  -> {metric: {current, plan, execution, status}}
  GET  /summary_api/api/monthly-progress?period=..&branch_guids=..
       -> {execution_percent, progress_percent, forecast_percent, plan_amount, fact_amount}
          ("План продаж на очки выполнен на …%" on the home page)

Every request goes through a shared Throttle (see throttle.py) and is retried
with exponential backoff only on temporary server problems.
"""
from __future__ import annotations

import asyncio
import random
from datetime import datetime
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

from .throttle import Throttle

API_PREFIX = "/summary_api"
TIMEOUT = httpx.Timeout(30.0, connect=15.0)
ATTEMPTS = 3
BACKOFF = (3.0, 10.0)        # pause before the 2nd and 3rd attempt (plus jitter)
MAX_RETRY_AFTER = 120.0
RETRY_STATUSES = {429, 502, 503, 504}


class OptimizerError(Exception):
    """Error with a human readable (Russian) message for the UI."""


class ServerBusyError(OptimizerError):
    """The site is down / overloaded / rate limiting us: back off, don't push harder."""


def normalize_base_url(raw: str) -> str:
    """'demo-optics.optmzr.ru/login' -> 'https://demo-optics.optmzr.ru'."""
    raw = (raw or "").strip()
    if not raw:
        raise OptimizerError("Укажите адрес сайта")
    if "://" not in raw:
        raw = "https://" + raw
    parts = urlsplit(raw)
    if not parts.netloc:
        raise OptimizerError("Некорректный адрес сайта")
    return f"{parts.scheme}://{parts.netloc}".lower()


@dataclass
class CollectResult:
    period: str
    kpi: dict
    progress: dict | None = None
    branches: list[dict] = field(default_factory=list)
    source_updated_at: str | None = None


class OptimizerClient:
    def __init__(self, base_url: str, login: str, password: str,
                 http: httpx.AsyncClient, throttle: Throttle):
        self.base_url = normalize_base_url(base_url)
        self.host = urlsplit(self.base_url).netloc
        self.api = self.base_url + API_PREFIX
        self.login_name = login
        self.password = password
        self.http = http
        self.throttle = throttle
        self.token: str | None = None
        self.user: dict | None = None

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        headers = kw.pop("headers", {})
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        problem = ""
        for attempt in range(ATTEMPTS):
            if attempt:
                delay = BACKOFF[min(attempt - 1, len(BACKOFF) - 1)]
                await asyncio.sleep(delay * random.uniform(1.0, 1.5))
            try:
                async with self.throttle.slot(self.host):
                    resp = await self.http.request(method, self.api + path, headers=headers,
                                                   timeout=TIMEOUT, **kw)
            except httpx.TimeoutException:
                problem = "сайт не ответил вовремя"
                continue
            except httpx.HTTPError as exc:
                problem = f"нет соединения ({type(exc).__name__})"
                continue
            if resp.status_code not in RETRY_STATUSES:
                return resp
            problem = f"сервер перегружен или недоступен (HTTP {resp.status_code})"
            retry_after = _retry_after(resp)
            if resp.status_code == 429 or retry_after:
                self.throttle.cool_down(self.host, min(retry_after or 30.0, MAX_RETRY_AFTER))
        raise ServerBusyError(f"{self.host}: {problem}")

    async def _get_json(self, path: str, params: dict | list | None = None):
        resp = await self._request("GET", path, params=params)
        if resp.status_code == 401:
            raise OptimizerError("Сессия не принята сервером (401)")
        if resp.status_code >= 400:
            raise OptimizerError(f"Ошибка API {path}: HTTP {resp.status_code}")
        try:
            return resp.json()
        except ValueError:
            raise OptimizerError(f"Сервер вернул не JSON на {path}") from None

    async def login(self) -> dict:
        resp = await self._request(
            "POST", "/api/auth/login",
            json={"email": self.login_name, "password": self.password},
        )
        if resp.status_code in (400, 401, 403):
            detail = _detail(resp)
            raise OptimizerError(f"Неверный логин или пароль{': ' + detail if detail else ''}")
        if resp.status_code >= 400:
            raise OptimizerError(f"Не удалось войти: HTTP {resp.status_code} {_detail(resp)}".strip())
        try:
            data = resp.json()
            self.token = data["access_token"]
        except (ValueError, KeyError):
            raise OptimizerError("Сайт ответил, но это не похоже на Оптимайзер (нет токена)") from None
        self.user = data.get("user") or {}
        return self.user

    async def default_period(self) -> str:
        data = await self._get_json("/api/default-period")
        period = data.get("period") if isinstance(data, dict) else None
        return period or datetime.now().strftime("%Y-%m")

    async def branches(self) -> list[dict]:
        data = await self._get_json("/api/branches")
        if not isinstance(data, list):
            raise OptimizerError("Сайт вернул список салонов в неожиданном виде")
        return [
            {"id": b.get("id"), "name": b.get("name") or b.get("id"), "is_active": b.get("is_active", True)}
            for b in data if isinstance(b, dict) and b.get("id")
        ]

    @staticmethod
    def _params(period: str, branch_ids: list[str] | None) -> list[tuple[str, str]]:
        return [("period", period), *(("branch_guids", b) for b in branch_ids or [])]

    async def kpi(self, period: str, branch_ids: list[str] | None = None) -> dict:
        data = await self._get_json("/api/kpi", params=self._params(period, branch_ids))
        if not isinstance(data, dict):
            raise OptimizerError("Сайт вернул показатели в неожиданном виде")
        return data

    async def monthly_progress(self, period: str, branch_ids: list[str] | None = None) -> dict | None:
        """Sales plan progress. Optional: an error here must not fail the whole collection."""
        try:
            data = await self._get_json("/api/monthly-progress", params=self._params(period, branch_ids))
        except ServerBusyError:
            raise
        except OptimizerError:
            return None
        return data if isinstance(data, dict) else None

    async def collect(self, period: str | None = None) -> CollectResult:
        """Log in and fetch the dashboard: totals + every branch.

        Requests are made one after another (the throttle serialises them per site anyway),
        so a client with N branches costs 5 + 2N requests.
        """
        await self.login()
        period = period or await self.default_period()
        branches = await self.branches()
        total = await self.kpi(period)
        progress = await self.monthly_progress(period)

        rows = []
        for b in branches:
            try:
                b_kpi = await self.kpi(period, [b["id"]])
                b_kpi.pop("last_update_date", None)
                rows.append({**b, "kpi": b_kpi, "progress": await self.monthly_progress(period, [b["id"]])})
            except ServerBusyError:
                raise
            except OptimizerError as exc:
                rows.append({**b, "kpi": None, "progress": None, "error": str(exc)})

        updated = total.pop("last_update_date", None)
        return CollectResult(period=period, kpi=total, progress=progress, branches=rows,
                             source_updated_at=updated)


def _retry_after(resp: httpx.Response) -> float | None:
    value = resp.headers.get("Retry-After")
    try:
        return float(value) if value else None
    except ValueError:
        return None


def _detail(resp: httpx.Response) -> str:
    try:
        d = resp.json().get("detail")
    except (ValueError, AttributeError):
        return ""
    if isinstance(d, str):
        return d
    if isinstance(d, list):
        return "; ".join(str(x.get("msg", x)) for x in d if isinstance(x, dict))
    return ""
