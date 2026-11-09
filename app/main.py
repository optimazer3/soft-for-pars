"""HTTP API + static frontend."""
from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from datetime import datetime
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from . import auth, db
from .collector import CooldownError, collector
from .crypto import decrypt, encrypt
from .optimizer import OptimizerError, normalize_base_url
from .scheduler import next_slot, scheduler_loop

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Metrics shown on the dashboard overview (same as the Optimizer home page cards).
KEY_METRICS = [
    "lost_count", "loading_percentage", "selection_to_prescription", "prescription_to_order",
    "lost_percentage", "foreign_orders_percentage", "own_orders_avg_check",
    "foreign_orders_avg_check", "sales_amount", "average_check",
]


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    db.conn()
    db.execute("UPDATE clients SET last_status = 'error', last_error = 'Сбор прерван' "
               "WHERE last_status = 'running'")
    task = asyncio.create_task(scheduler_loop())
    yield
    task.cancel()
    await collector.close()


app = FastAPI(title="Optimizer Dashboard", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

PUBLIC_API = {"/api/auth/login", "/api/auth/me"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api/* call needs a valid session cookie (except login itself)."""
    path = request.url.path
    if path.startswith("/api/") and path not in PUBLIC_API:
        if not auth.read_session(request.cookies.get(auth.COOKIE_NAME)):
            return JSONResponse({"detail": "Требуется вход"}, status_code=401)
    return await call_next(request)


# ---------- auth ----------

class LoginIn(BaseModel):
    login: str = Field(max_length=100)
    password: str = Field(max_length=200)
    remember: bool = True


class CredentialsIn(BaseModel):
    current_password: str
    new_login: str = Field(min_length=3, max_length=50)
    new_password: str = Field(min_length=8, max_length=200)


def _set_session_cookie(request: Request, response: Response, remember: bool) -> None:
    value, ttl = auth.make_session(remember)
    response.set_cookie(
        auth.COOKIE_NAME, value, max_age=ttl if remember else None, httponly=True,
        samesite="lax", secure=request.url.scheme == "https", path="/",
    )


@app.post("/api/auth/login")
async def login(body: LoginIn, request: Request, response: Response):
    ip = request.client.host if request.client else "?"
    locked = auth.lock_remaining(ip)
    if locked:
        raise HTTPException(429, f"Слишком много неудачных попыток. Попробуйте через {locked} с")
    ok = await asyncio.to_thread(auth.check_credentials, body.login, body.password)
    if not ok:
        await asyncio.sleep(0.6)  # slows down guessing
        lock = auth.register_failure(ip)
        if lock:
            raise HTTPException(429, f"Слишком много неудачных попыток. Вход заблокирован на {lock} с")
        raise HTTPException(401, "Неверный логин или пароль")
    auth.register_success(ip)
    _set_session_cookie(request, response, body.remember)
    return {"login": auth.account()["login"]}


@app.post("/api/auth/logout")
def logout(response: Response):
    response.delete_cookie(auth.COOKIE_NAME, path="/")
    return {"ok": True}


@app.get("/api/auth/me")
def me(request: Request):
    login_name = auth.read_session(request.cookies.get(auth.COOKIE_NAME))
    if not login_name:
        raise HTTPException(401, "Требуется вход")
    return {"login": login_name}


@app.put("/api/auth/credentials")
async def change_credentials(body: CredentialsIn, request: Request, response: Response):
    ok = await asyncio.to_thread(auth.verify_password, body.current_password, auth.account()["hash"])
    if not ok:
        await asyncio.sleep(0.6)
        raise HTTPException(400, "Текущий пароль указан неверно")
    await asyncio.to_thread(auth.change_credentials, body.new_login, body.new_password)
    _set_session_cookie(request, response, True)  # other sessions are logged out
    return {"login": auth.account()["login"]}


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
    row["enabled"] = bool(row["enabled"])
    return row


def get_client_or_404(client_id: int) -> dict:
    row = db.query_one(f"SELECT {CLIENT_COLUMNS} FROM clients WHERE id = ?", (client_id,))
    if not row:
        raise HTTPException(404, "Клиент не найден")
    return public_client(row)


# ---------- clients ----------

@app.get("/api/clients")
def list_clients():
    return [public_client(r) for r in db.query(f"SELECT {CLIENT_COLUMNS} FROM clients ORDER BY name COLLATE NOCASE")]


@app.get("/api/clients/{client_id}")
def get_client(client_id: int):
    return get_client_or_404(client_id)


@app.post("/api/clients", status_code=201)
def create_client(body: ClientIn):
    if not body.password:
        raise HTTPException(422, "Укажите пароль")
    ts = db.now_iso()
    cid = db.execute(
        "INSERT INTO clients(name, base_url, login, password_enc, enabled, notes, created_at, updated_at) "
        "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
        (body.name, body.base_url, body.login, encrypt(body.password), int(body.enabled), body.notes, ts, ts),
    )
    return get_client_or_404(cid)


@app.put("/api/clients/{client_id}")
def update_client(client_id: int, body: ClientIn):
    get_client_or_404(client_id)
    fields = {"name": body.name, "base_url": body.base_url, "login": body.login,
              "enabled": int(body.enabled), "notes": body.notes, "updated_at": db.now_iso()}
    if body.password:
        fields["password_enc"] = encrypt(body.password)
    sets = ", ".join(f"{k} = :{k}" for k in fields)
    db.execute(f"UPDATE clients SET {sets} WHERE id = :id", {**fields, "id": client_id})
    return get_client_or_404(client_id)


@app.delete("/api/clients/{client_id}", status_code=204)
def delete_client(client_id: int):
    get_client_or_404(client_id)
    db.execute("DELETE FROM clients WHERE id = ?", (client_id,))


@app.post("/api/clients/test")
async def test_connection(body: TestIn):
    base_url, login, password = body.base_url, body.login, body.password
    if body.client_id and not password:
        row = db.query_one("SELECT * FROM clients WHERE id = ?", (body.client_id,))
        if not row:
            raise HTTPException(404, "Клиент не найден")
        base_url = base_url or row["base_url"]
        login = login or row["login"]
        password = decrypt(row["password_enc"])
    if not (base_url and login and password):
        raise HTTPException(422, "Заполните адрес, логин и пароль")
    try:
        return await collector.test_connection(base_url, login, password)
    except OptimizerError as exc:
        raise HTTPException(400, str(exc)) from None


# ---------- sync ----------

@app.post("/api/clients/{client_id}/sync")
async def sync_client(client_id: int):
    get_client_or_404(client_id)
    try:
        result = await collector.sync_client(client_id)
    except CooldownError as exc:
        raise HTTPException(429, str(exc)) from None
    return {**result, "client": get_client_or_404(client_id)}


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
    clients = db.query(f"SELECT {CLIENT_COLUMNS} FROM clients ORDER BY name COLLATE NOCASE")
    snaps = {
        r["client_id"]: r for r in db.query(
            "SELECT s.client_id, s.period, s.fetched_at, s.source_updated_at, s.kpi_json, s.progress_json, "
            "       json_array_length(s.branches_json) AS branches_count "
            "FROM snapshots s JOIN (SELECT client_id, MAX(fetched_at) AS m FROM snapshots GROUP BY client_id) l "
            "  ON l.client_id = s.client_id AND l.m = s.fetched_at"
        )
    }
    out = []
    for c in clients:
        item = public_client(c)
        s = snaps.get(c["id"])
        if s:
            kpi = json.loads(s["kpi_json"])
            item["snapshot"] = {
                "period": s["period"], "fetched_at": s["fetched_at"],
                "source_updated_at": s["source_updated_at"], "branches_count": s["branches_count"],
                "kpi": {k: kpi[k] for k in KEY_METRICS if k in kpi},
                "progress": json.loads(s["progress_json"]) if s["progress_json"] else None,
            }
        else:
            item["snapshot"] = None
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

@app.get("/api/settings")
def get_settings():
    s = db.get_settings()
    nxt = next_slot(s["schedule_times"], datetime.now().astimezone()) if s["schedule_enabled"] else None
    return {**s, "next_run": nxt.isoformat(timespec="minutes") if nxt else None}


@app.put("/api/settings")
def put_settings(body: SettingsIn):
    db.set_settings(body.model_dump())
    # Don't treat slots that already passed today as "missed" after a schedule change.
    db.set_settings({"last_scheduled_run": db.now_iso()})
    return get_settings()


# ---------- frontend ----------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})
