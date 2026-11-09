"""Client for an Optimizer site (https://<client>.optmzr.ru).

The site's frontend talks to a JSON API under /summary_api:
  POST /summary_api/api/auth/login   {"email": <login>, "password": ...} -> {"access_token": ...}
  GET  /summary_api/api/default-period                 -> {"period": "YYYY-MM"}
  GET  /summary_api/api/branches                       -> [{"id", "name", "is_active", ...}]
  GET  /summary_api/api/kpi?period=..&branch_guids=..  -> {metric: {current, plan, execution, status}}
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

API_PREFIX = "/summary_api"
TIMEOUT = httpx.Timeout(30.0, connect=15.0)
RETRIES = 3


class OptimizerError(Exception):
    """Error with a human readable (Russian) message for the UI."""


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
    branches: list[dict] = field(default_factory=list)
    source_updated_at: str | None = None


class OptimizerClient:
    def __init__(self, base_url: str, login: str, password: str, http: httpx.AsyncClient):
        self.base_url = normalize_base_url(base_url)
        self.api = self.base_url + API_PREFIX
        self.login_name = login
        self.password = password
        self.http = http
        self.token: str | None = None
        self.user: dict | None = None

    async def _request(self, method: str, path: str, **kw) -> httpx.Response:
        headers = kw.pop("headers", {})
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        last_exc: Exception | None = None
        for attempt in range(RETRIES):
            try:
                resp = await self.http.request(method, self.api + path, headers=headers,
                                               timeout=TIMEOUT, **kw)
            except httpx.HTTPError as exc:  # network problems: retry
                last_exc = exc
            else:
                if resp.status_code not in (502, 503, 504):
                    return resp
                last_exc = OptimizerError(f"Сервер Оптимайзера недоступен (HTTP {resp.status_code})")
            await asyncio.sleep(1.5 * (attempt + 1))
        if isinstance(last_exc, OptimizerError):
            raise last_exc
        raise OptimizerError(f"Сайт {self.base_url} недоступен: {type(last_exc).__name__}")

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
        return data.get("period")

    async def branches(self) -> list[dict]:
        data = await self._get_json("/api/branches")
        return [
            {"id": b.get("id"), "name": b.get("name") or b.get("id"), "is_active": b.get("is_active", True)}
            for b in data if isinstance(b, dict) and b.get("id")
        ]

    async def kpi(self, period: str, branch_ids: list[str] | None = None) -> dict:
        params: list[tuple[str, str]] = [("period", period)]
        for b in branch_ids or []:
            params.append(("branch_guids", b))
        return await self._get_json("/api/kpi", params=params)

    async def collect(self, period: str | None = None) -> CollectResult:
        """Log in and fetch the dashboard: totals + every branch."""
        await self.login()

        async def no_period() -> str:
            return period

        period, branches = await asyncio.gather(
            no_period() if period else self.default_period(), self.branches()
        )

        async def branch_kpi(b: dict) -> dict:
            try:
                return {**b, "kpi": await self.kpi(period, [b["id"]])}
            except OptimizerError as exc:
                return {**b, "kpi": None, "error": str(exc)}

        total, *branch_rows = await asyncio.gather(
            self.kpi(period), *(branch_kpi(b) for b in branches)
        )
        updated = total.pop("last_update_date", None)
        for b in branch_rows:
            if b.get("kpi"):
                b["kpi"].pop("last_update_date", None)
        return CollectResult(period=period, kpi=total, branches=branch_rows,
                             source_updated_at=updated)


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
