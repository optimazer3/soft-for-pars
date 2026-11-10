"""Admin panel API (/api/admin/*, admins only — checked by the middleware in main.py)."""
from __future__ import annotations

import os
import secrets
import string
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator

from . import auth, db
from .collector import collector

router = APIRouter(prefix="/api/admin")

FREE_TIER_DB_BYTES = 500 * 1024 * 1024  # Supabase free plan
APP_TZ = os.environ.get("APP_TZ", "Europe/Moscow")  # "today" and daily charts are counted in this zone


def _actor(request: Request) -> dict:
    return request.state.user


def _audit(request: Request, action: str, target: str | None = None, details: dict | None = None) -> None:
    auth.log_event(_actor(request)["login"], action, target,
                   ip=request.client.host if request.client else None,
                   ua=request.headers.get("user-agent"), details=details)


def _user_or_404(user_id: int) -> dict:
    row = db.query_one("SELECT id, login, password, role, disabled FROM app.users WHERE id = %s", (user_id,))
    if not row:
        raise HTTPException(404, "Пользователь не найден")
    return row


def _active_admins(exclude_id: int | None = None) -> int:
    row = db.query_one("SELECT count(*) AS n FROM app.users WHERE role = 'admin' AND NOT disabled "
                       "AND id IS DISTINCT FROM %s", (exclude_id,))
    return row["n"]


# ---------- overview ----------

@router.get("/overview")
def overview():
    online = db.query(
        """
        SELECT s.login, u.role, min(s.started_at) AS since, max(s.last_seen_at) AS last_seen,
               count(*) AS sessions,
               (array_agg(s.ip ORDER BY s.last_seen_at DESC))[1] AS ip,
               (array_agg(s.user_agent ORDER BY s.last_seen_at DESC))[1] AS user_agent
        FROM app.sessions s LEFT JOIN app.users u ON lower(u.login) = lower(s.login)
        WHERE s.ended_at IS NULL AND s.last_seen_at > now() - make_interval(mins => %s)
        GROUP BY s.login, u.role ORDER BY max(s.last_seen_at) DESC
        """,
        (auth.ONLINE_MINUTES,),
    )
    stats = db.query_one(
        """
        WITH t AS (SELECT (date_trunc('day', now() AT TIME ZONE %(tz)s) AT TIME ZONE %(tz)s) AS day_start)
        SELECT
          (SELECT count(*) FROM app.events, t WHERE action = 'login' AND at >= t.day_start) AS logins_today,
          (SELECT count(DISTINCT actor) FROM app.events, t WHERE action = 'login' AND at >= t.day_start) AS users_today,
          (SELECT count(*) FROM app.events WHERE action = 'login_failed' AND at > now() - interval '24 hours') AS failed_24h,
          (SELECT count(*) FROM app.users) AS users_total,
          (SELECT count(*) FROM app.users WHERE role = 'admin') AS admins,
          (SELECT count(*) FROM app.users WHERE disabled) AS users_disabled,
          (SELECT count(*) FROM app.clients) AS clients_total,
          (SELECT count(*) FROM app.clients WHERE enabled) AS clients_enabled,
          (SELECT count(*) FROM app.clients WHERE enabled AND last_status = 'error') AS clients_error,
          pg_database_size(current_database()) AS db_bytes
        """,
        {"tz": APP_TZ},
    )
    # visits per day for the last 14 days (sessions started + distinct people)
    days = db.query(
        """
        WITH today AS (SELECT (now() AT TIME ZONE %(tz)s)::date AS d)
        SELECT g::date AS day,
               (SELECT count(*) FROM app.sessions s WHERE (s.started_at AT TIME ZONE %(tz)s)::date = g::date) AS visits,
               (SELECT count(DISTINCT e.actor) FROM app.events e
                 WHERE e.action = 'login' AND (e.at AT TIME ZONE %(tz)s)::date = g::date) AS people
        FROM today, generate_series(today.d - 13, today.d, interval '1 day') AS g
        ORDER BY g
        """,
        {"tz": APP_TZ},
    )
    st = collector.status()
    return {
        "online": online,
        "online_minutes": auth.ONLINE_MINUTES,
        **stats,
        "db_limit_bytes": FREE_TIER_DB_BYTES,
        "days": days,
        "sync": st,
    }


# ---------- users ----------

class UserIn(BaseModel):
    login: str = Field(min_length=3, max_length=50)
    password: str = Field(min_length=6, max_length=200)
    role: str = "user"

    @field_validator("login")
    @classmethod
    def clean_login(cls, v: str) -> str:
        v = v.strip()
        if any(ch.isspace() for ch in v):
            raise ValueError("Логин без пробелов")
        return v

    @field_validator("role")
    @classmethod
    def valid_role(cls, v: str) -> str:
        if v not in ("user", "admin"):
            raise ValueError("Неизвестная роль")
        return v


class UserPatch(BaseModel):
    login: str | None = Field(default=None, min_length=3, max_length=50)
    role: str | None = None
    disabled: bool | None = None

    @field_validator("login")
    @classmethod
    def clean_login(cls, v: str | None) -> str | None:
        return UserIn.clean_login(v) if v is not None else None

    @field_validator("role")
    @classmethod
    def valid_role(cls, v: str | None) -> str | None:
        if v is not None and v not in ("user", "admin"):
            raise ValueError("Неизвестная роль")
        return v


class PasswordIn(BaseModel):
    password: str = Field(min_length=6, max_length=200)
    current_password: str | None = None  # required when changing your own password


@router.get("/users")
def list_users():
    return db.query(
        """
        SELECT u.id, u.login, u.role, u.disabled, u.created_at, u.last_login_at,
               max(s.last_seen_at) AS last_seen_at,
               bool_or(s.ended_at IS NULL AND s.last_seen_at > now() - make_interval(mins => %s)) AS online,
               count(s.id) FILTER (WHERE s.ended_at IS NULL) AS open_sessions
        FROM app.users u LEFT JOIN app.sessions s ON lower(s.login) = lower(u.login)
        GROUP BY u.id ORDER BY (u.role = 'admin') DESC, lower(u.login)
        """,
        (auth.ONLINE_MINUTES,),
    )


@router.post("/users", status_code=201)
def create_user(body: UserIn, request: Request):
    if auth.get_user(body.login) or db.query_one("SELECT 1 AS x FROM app.users WHERE lower(login) = lower(%s)",
                                                 (body.login,)):
        raise HTTPException(400, "Такой логин уже есть")
    db.execute("INSERT INTO app.users(login, password, role) VALUES(%s, %s, %s)",
               (body.login, body.password, body.role))
    auth.invalidate_cache()
    _audit(request, "user_created", body.login, {"role": body.role})
    return {"ok": True}


@router.put("/users/{user_id}")
def update_user(user_id: int, body: UserPatch, request: Request):
    u = _user_or_404(user_id)
    me = _actor(request)
    is_me = u["login"].lower() == me["login"].lower()
    changes: dict = {}
    if body.login is not None and body.login != u["login"]:
        if db.query_one("SELECT 1 AS x FROM app.users WHERE lower(login) = lower(%s) AND id <> %s",
                        (body.login, user_id)):
            raise HTTPException(400, "Такой логин уже есть")
        changes["login"] = body.login
    if body.role is not None and body.role != u["role"]:
        if u["role"] == "admin" and _active_admins(exclude_id=user_id) == 0:
            raise HTTPException(400, "Нельзя убрать последнего администратора")
        if is_me:
            raise HTTPException(400, "Свою роль изменить нельзя")
        changes["role"] = body.role
    if body.disabled is not None and body.disabled != u["disabled"]:
        if is_me:
            raise HTTPException(400, "Нельзя отключить самого себя")
        if body.disabled and u["role"] == "admin" and _active_admins(exclude_id=user_id) == 0:
            raise HTTPException(400, "Нельзя отключить последнего администратора")
        changes["disabled"] = body.disabled
    if not changes:
        return {"ok": True}
    sets = ", ".join(f"{k} = %({k})s" for k in changes)
    db.execute(f"UPDATE app.users SET {sets}, updated_at = now() WHERE id = %(id)s", {**changes, "id": user_id})
    if "login" in changes:
        db.execute("UPDATE app.sessions SET login = %s WHERE lower(login) = lower(%s)", (changes["login"], u["login"]))
    if changes.get("disabled"):
        auth.end_sessions(changes.get("login", u["login"]), "disabled")
    auth.invalidate_cache()
    _audit(request, "user_updated", changes.get("login", u["login"]),
           {k: v for k, v in changes.items()} | ({"old_login": u["login"]} if "login" in changes else {}))
    return {"ok": True}


@router.post("/users/{user_id}/password")
def set_password(user_id: int, body: PasswordIn, request: Request, response: Response):
    u = _user_or_404(user_id)
    me = _actor(request)
    is_me = u["login"].lower() == me["login"].lower()
    if is_me and not secrets.compare_digest((body.current_password or "").encode(), (u["password"] or "").encode()):
        raise HTTPException(400, "Текущий пароль указан неверно")
    db.execute("UPDATE app.users SET password = %s, updated_at = now() WHERE id = %s", (body.password, user_id))
    auth.end_sessions(u["login"], "password_changed", except_sid=me["sid"] if is_me else None)
    auth.invalidate_cache()
    _audit(request, "password_changed", u["login"])
    if is_me:  # the cookie carries a fingerprint of the password: give this browser a fresh one
        fresh = auth.get_user(u["login"])
        response.set_cookie(
            auth.COOKIE_NAME, auth.make_cookie(fresh, me["sid"], me["remember"]),
            max_age=auth.COOKIE_MAX_AGE if me["remember"] else None, httponly=True,
            samesite="lax", secure=request.url.scheme == "https", path="/",
        )
    return {"ok": True}


@router.post("/users/{user_id}/logout")
def logout_user(user_id: int, request: Request):
    u = _user_or_404(user_id)
    me = _actor(request)
    n = auth.end_sessions(u["login"], "revoked", except_sid=me["sid"])
    _audit(request, "sessions_revoked", u["login"], {"count": n})
    return {"ended": n}


@router.delete("/users/{user_id}", status_code=204)
def delete_user(user_id: int, request: Request):
    u = _user_or_404(user_id)
    if u["login"].lower() == _actor(request)["login"].lower():
        raise HTTPException(400, "Нельзя удалить самого себя")
    if u["role"] == "admin" and _active_admins(exclude_id=user_id) == 0:
        raise HTTPException(400, "Нельзя удалить последнего администратора")
    db.execute("DELETE FROM app.users WHERE id = %s", (user_id,))
    auth.end_sessions(u["login"], "deleted")
    auth.invalidate_cache()
    _audit(request, "user_deleted", u["login"])


@router.get("/generate-password")
def generate_password():
    alphabet = string.ascii_letters + string.digits
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(12))
        if any(c.isdigit() for c in pw) and any(c.isupper() for c in pw) and any(c.islower() for c in pw):
            return {"password": pw}


# ---------- log & sessions ----------

@router.get("/events")
def events(limit: int = 100, before: int | None = None, login: str | None = None, kind: str | None = None):
    kinds = {
        "auth": ("login", "logout", "login_failed"),
        "failed": ("login_failed",),
        "users": ("user_created", "user_updated", "user_deleted", "password_changed", "sessions_revoked",
                  "password_reset", "user_renamed"),
        "data": ("client_created", "client_updated", "client_deleted", "settings_changed", "sync_all"),
    }
    where, params = [], []
    if before:
        where.append("id < %s"); params.append(before)
    if login:
        where.append("(lower(actor) = lower(%s) OR lower(target) = lower(%s))"); params += [login, login]
    if kind in kinds:
        where.append("action = ANY(%s)"); params.append(list(kinds[kind]))
    sql = "SELECT id, at, actor, action, target, ip, user_agent, details FROM app.events"
    if where:
        sql += " WHERE " + " AND ".join(where)
    sql += " ORDER BY id DESC LIMIT %s"
    params.append(max(1, min(limit, 500)))
    return db.query(sql, tuple(params))


@router.get("/sessions")
def sessions(days: int = 7, login: str | None = None):
    params: list = [auth.ONLINE_MINUTES, max(1, min(days, 90))]
    sql = """
        SELECT id, login, started_at, last_seen_at, ended_at, end_reason, ip, user_agent, remember,
               (ended_at IS NULL AND last_seen_at > now() - make_interval(mins => %s)) AS online
        FROM app.sessions WHERE last_seen_at > now() - make_interval(days => %s)"""
    if login:
        sql += " AND lower(login) = lower(%s)"; params.append(login)
    sql += " ORDER BY last_seen_at DESC LIMIT 300"
    return db.query(sql, tuple(params))


@router.post("/sessions/{sid}/end")
def end_one(sid: str, request: Request):
    row = db.query_one("SELECT login FROM app.sessions WHERE id = %s", (sid,))
    if not row:
        raise HTTPException(404, "Сессия не найдена")
    if sid == _actor(request)["sid"]:
        raise HTTPException(400, "Это ваша текущая сессия — воспользуйтесь кнопкой «Выйти»")
    auth.end_session(sid, "revoked")
    _audit(request, "sessions_revoked", row["login"], {"count": 1})
    return {"ok": True}


@router.get("/now")
def server_time():
    return {"now": datetime.now().astimezone().isoformat(timespec="seconds")}
