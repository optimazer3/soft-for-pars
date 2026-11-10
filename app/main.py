"""HTTP API + static frontend."""
from __future__ import annotations

import asyncio
import contextlib
import hmac
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .env import load_env

load_env()

from . import auth, db  # noqa: E402
from .collector import CooldownError, collector
from .optimizer import OptimizerError, normalize_base_url
from .scheduler import next_slot, scheduler_loop

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# KPI metrics shown on the dashboard (the rest of the summary comes from progress/extras).
KEY_METRICS = ["sales_amount", "vtl_orders_count"]


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    db.execute("UPDATE app.clients SET last_status = 'error', last_error = 'Сбор прерван' "
               "WHERE last_status = 'running'")
    db.prune_snapshots(int(db.get_settings().get("snapshot_retention_days") or 7))
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    await collector.close()
    db.close()


app = FastAPI(title="Optimizer Dashboard", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

PUBLIC_API = {"/api/auth/login", "/api/auth/me"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api/* call needs a valid session cookie (except login itself)."""
    path = request.url.path
    if path.startswith("/api/") and path not in PUBLIC_API:
        if not await asyncio.to_thread(auth.read_session, request.cookies.get(auth.COOKIE_NAME)):
            return JSONResponse({"detail": "Требуется вход"}, status_code=401)
    return await call_next(request)


@app.exception_handler(Exception)
async def unexpected_error(request: Request, exc: Exception):
    """Database hiccups and bugs: log the details, show the user a calm message."""
    logging.getLogger("app").exception("unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "Сервис временно недоступен. Попробуйте ещё раз чуть позже."}, status_code=503)


# ---------- auth ----------

class LoginIn(BaseModel):
    login: str = Field(max_length=100)
    password: str = Field(max_length=200)
    remember: bool = True


class CredentialsIn(BaseModel):
    current_password: str
    new_login: str = Field(min_length=3, max_length=50)
    new_password: str = Field(min_length=8, max_length=200)


def _send_cookie(request: Request, response: Response, value: str, remember: bool) -> None:
    response.set_cookie(
        auth.COOKIE_NAME, value, max_age=auth.COOKIE_MAX_AGE if remember else None, httponly=True,
        samesite="lax", secure=request.url.scheme == "https", path="/",
    )


def _set_session_cookie(request: Request, response: Response, login: str, remember: bool) -> None:
    _send_cookie(request, response, auth.make_session(login, remember), remember)


@app.post("/api/auth/login")
async def login(body: LoginIn, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    locked = auth.lock_remaining(ip)
    if locked:
        raise HTTPException(429, f"Слишком много неудачных попыток. Попробуйте через {locked} с")
    login_name = await asyncio.to_thread(auth.check_credentials, body.login, body.password)
    if not login_name:
        await asyncio.sleep(0.6)  # slows down guessing
        lock = auth.register_failure(ip)
        if lock:
            raise HTTPException(429, f"Слишком много неудачных попыток. Вход заблокирован на {lock} с")
        raise HTTPException(401, "Неверный логин или пароль")
    auth.register_success(ip)
    await asyncio.to_thread(_set_session_cookie, request, response, login_name, body.remember)
    return {"login": login_name}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request, response: Response):
    cookie = request.cookies.get(auth.COOKIE_NAME)
    parsed = auth.parse_session(cookie)
    if not parsed:
        raise HTTPException(401, "Требуется вход")
    login_name, remember = parsed
    if remember:  # renew the cookie on every visit, so "remember me" never runs out
        _send_cookie(request, response, cookie, True)
    return {"login": login_name}


@app.put("/api/auth/credentials")
async def change_credentials(body: CredentialsIn, request: Request, response: Response):
    parsed = await asyncio.to_thread(auth.parse_session, request.cookies.get(auth.COOKIE_NAME))
    login_name, remember = parsed or ("", False)
    stored = await asyncio.to_thread(auth.current_password, login_name)
    if stored is None or not hmac.compare_digest(body.current_password.encode(), stored.encode()):
        await asyncio.sleep(0.6)
        raise HTTPException(400, "Текущий пароль указан неверно")
    try:
        await asyncio.to_thread(auth.change_credentials, login_name, body.new_login, body.new_password)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    new_login = body.new_login.strip()
    # A new cookie for this browser; every other session of the user ends.
    await asyncio.to_thread(_set_session_cookie, request, response, new_login, remember)
    return {"login": new_login}


# ---------- models ----------

class ClientIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    base_url: str
    login: str = Field(min_length=1)
    password: str | None = None  # empty on edit = keep the old one
    enabled: bool = True
    notes: str = ""

    @field_validator("name", "login", "notes")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()

    @field_validator("base_url")
    @classmethod
    def url(cls, v: str) -> str:
        try:
            return normalize_base_url(v)
        except OptimizerError as exc:
            raise ValueError(str(exc)) from None


class TestIn(BaseModel):
    base_url: str | None = None
    login: str | None = None
    password: str | None = None
    client_id: int | None = None


class SettingsIn(BaseModel):
    schedule_enabled: bool
    schedule_times: list[str]
    concurrency: int = Field(ge=1, le=5)
    request_interval_ms: int = Field(ge=200, le=5000)
    cooldown_min: int = Field(ge=0, le=180)
    snapshot_retention_days: int = Field(ge=1, le=90)

    @field_validator("schedule_times")
    @classmethod
    def times(cls, v: list[str]) -> list[str]:
        out = []
        for t in v:
            try:
                parsed = datetime.strptime(t.strip(), "%H:%M")
            except ValueError:
                raise ValueError(f"Неверное время: {t}") from None
            out.append(parsed.strftime("%H:%M"))
        return sorted(set(out))


# ---------- helpers ----------

CLIENT_COLUMNS = ("id, name, base_url, login, enabled, notes, created_at, updated_at, "
                  "last_sync_at, last_status, last_error")


def public_client(row: dict) -> dict:
    row = dict(row)
    row.pop("password_enc", None)
    row.pop("password", None)
    return row


def get_client_or_404(client_id: int) -> dict:
    row = db.query_one(f"SELECT {CLIENT_COLUMNS} FROM app.clients WHERE id = %s", (client_id,))
    if not row:
        raise HTTPException(404, "Клиент не найден")
    return public_client(row)


# ---------- clients ----------

@app.get("/api/clients")
def list_clients():
    return [public_client(r) for r in db.query(f"SELECT {CLIENT_COLUMNS} FROM app.clients ORDER BY lower(name)")]


@app.get("/api/clients/{client_id}")
def get_client(client_id: int):
    return get_client_or_404(client_id)


@app.post("/api/clients", status_code=201)
def create_client(body: ClientIn):
    if not body.password:
        raise HTTPException(422, "Укажите пароль")
    row = db.query_one(
        "INSERT INTO app.clients(name, base_url, login, password, enabled, notes) "
        "VALUES(%s, %s, %s, %s, %s, %s) RETURNING id",
        (body.name, body.base_url, body.login, body.password, body.enabled, body.notes),
    )
    return get_client_or_404(row["id"])


@app.put("/api/clients/{client_id}")
def update_client(client_id: int, body: ClientIn):
    get_client_or_404(client_id)
    fields = {"name": body.name, "base_url": body.base_url, "login": body.login,
              "enabled": body.enabled, "notes": body.notes, "updated_at": db.now()}
    if body.password:
        fields["password"] = body.password
    sets = ", ".join(f"{k} = %({k})s" for k in fields)
    db.execute(f"UPDATE app.clients SET {sets} WHERE id = %(id)s", {**fields, "id": client_id})
    return get_client_or_404(client_id)


@app.delete("/api/clients/{client_id}", status_code=204)
def delete_client(client_id: int):
    get_client_or_404(client_id)
    db.execute("DELETE FROM app.clients WHERE id = %s", (client_id,))


@app.post("/api/clients/test")
async def test_connection(body: TestIn):
    base_url, login, password = body.base_url, body.login, body.password
    if body.client_id and not password:
        row = await asyncio.to_thread(db.query_one, "SELECT * FROM app.clients WHERE id = %s", (body.client_id,))
        if not row:
            raise HTTPException(404, "Клиент не найден")
        base_url = base_url or row["base_url"]
        login = login or row["login"]
        password = row["password"]
    if not (base_url and login and password):
        raise HTTPException(422, "Заполните адрес, логин и пароль")
    try:
        return await collector.test_connection(base_url, login, password)
    except OptimizerError as exc:
        raise HTTPException(400, str(exc)) from None


# ---------- sync ----------

@app.post("/api/clients/{client_id}/sync")
async def sync_client(client_id: int):
    await asyncio.to_thread(get_client_or_404, client_id)
    try:
        result = await collector.sync_client(client_id)
    except CooldownError as exc:
        raise HTTPException(429, str(exc)) from None
    return {**result, "client": await asyncio.to_thread(get_client_or_404, client_id)}


@app.post("/api/sync", status_code=202)
async def sync_all():
    if not collector.state.running:
        asyncio.create_task(collector.sync_all(trigger="manual"))
        await asyncio.sleep(0)
    return collector.status()


@app.get("/api/sync/status")
def sync_status():
    return collector.status()


# ---------- dashboard ----------

@app.get("/api/dashboard")
def dashboard():
    clients = db.query(f"SELECT {CLIENT_COLUMNS} FROM app.clients ORDER BY lower(name)")
    # Newest snapshot per client; only the key metrics travel over the network.
    snaps = {
        r["client_id"]: r for r in db.query(
            """
            SELECT DISTINCT ON (s.client_id)
                   s.client_id, s.period, s.fetched_at, s.source_updated_at, s.progress, s.extras,
                   jsonb_array_length(s.branches) AS branches_count,
                   (SELECT coalesce(jsonb_object_agg(k, s.kpi -> k), '{}'::jsonb)
                      FROM unnest(%s::text[]) AS k WHERE s.kpi ? k) AS kpi
            FROM app.snapshots s
            ORDER BY s.client_id, s.fetched_at DESC
            """,
            (KEY_METRICS,),
        )
    }
    out = []
    for c in clients:
        item = public_client(c)
        s = snaps.get(c["id"])
        item["snapshot"] = {
            "period": s["period"], "fetched_at": s["fetched_at"],
            "source_updated_at": s["source_updated_at"], "branches_count": s["branches_count"],
            "kpi": s["kpi"], "progress": s["progress"], "extras": s["extras"] or {},
        } if s else None
        out.append(item)
    s = db.get_settings()
    nxt = next_slot(s["schedule_times"], datetime.now().astimezone()) if s["schedule_enabled"] else None
    return {
        "clients": out,
        "key_metrics": KEY_METRICS,
        "sync": collector.status(),
        "next_run": nxt.isoformat(timespec="minutes") if nxt else None,
    }


@app.get("/api/clients/{client_id}/snapshot")
def client_snapshot(client_id: int):
    client = get_client_or_404(client_id)
    return {"client": client, "snapshot": db.latest_snapshot(client_id), "key_metrics": KEY_METRICS}


# ---------- settings ----------

PUBLIC_SETTINGS = ("schedule_enabled", "schedule_times", "concurrency", "request_interval_ms",
                   "cooldown_min", "snapshot_retention_days")


@app.get("/api/settings")
def get_settings():
    s = db.get_settings()
    nxt = next_slot(s["schedule_times"], datetime.now().astimezone()) if s["schedule_enabled"] else None
    return {**{k: s[k] for k in PUBLIC_SETTINGS}, "next_run": nxt.isoformat(timespec="minutes") if nxt else None}


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    # last_scheduled_run = now: slots that already passed today are not treated as "missed".
    db.set_settings({**body.model_dump(), "last_scheduled_run": db.now_iso()})
    db.prune_snapshots(body.snapshot_retention_days)
    return get_settings()


# ---------- frontend ----------

class AppStatic(StaticFiles):
    """Static files that are always revalidated, so an update never mixes old and new scripts."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        if path.startswith("fonts/"):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        else:
            response.headers["Cache-Control"] = "no-cache"
        return response


app.mount("/static", AppStatic(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
