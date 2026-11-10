"""Sign-in, roles, sessions and the audit log.

* Users live in app.users (login + password in plain text, as requested by the owner) with a
  role: "admin" (sees the admin panel) or "user". They can be managed in the admin panel.
* Built-in accounts: admin / admin123 (role admin) is created when no admin exists; the shared
  account "user" with the master password (only its scrypt hash is in the code) is created on its
  first successful sign-in, once — deleting it later is final.
* Sessions: a signed HttpOnly cookie carries the session id; every session is a row in
  app.sessions (start, last activity, end, IP, browser). The cookie also carries a fingerprint of
  the user's password, so a password change ends all sessions of that user. An admin can end
  sessions; a disabled or deleted user is signed out at once.
* Every sign-in, failed attempt, sign-out and admin action is written to app.events.
* Brute-force protection: after a few wrong attempts from one IP the login is locked
  for a growing period.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import threading
import time
from collections import defaultdict
from dataclasses import dataclass

from psycopg.types.json import Jsonb

from . import db

COOKIE_NAME = "od_session"
# "Remember me" = stay signed in for good: the token is valid for 10 years and the cookie
# (browsers cap cookie lifetime at ~400 days) is renewed on every visit.
SESSION_DAYS_REMEMBER = 3650
COOKIE_MAX_AGE = 400 * 86400
SESSION_HOURS_DEFAULT = 12
ONLINE_MINUTES = 5            # "on the site now" = activity within this window
TOUCH_EVERY = 60.0            # write last activity at most once a minute per session

ADMIN_LOGIN = "admin"
ADMIN_DEFAULT_PASSWORD = "admin123"
SHARED_LOGIN = "user"
# scrypt hash of the master password of the shared account (the password itself is not in the code).
MASTER_HASH = (
    "scrypt$16384$8$1$bhgrwsHFUuEEmGKsU9CDiw="
    "=$KFpBtHNaCx7tH2OEQAgHg8lMz3Q6Bp4I8vP4Bx2YbO1aMrvqrn08p+qMr/TnP+rA/TZ+z0rzW/Ejn9w35lNaCA=="
)

SESSION_KEY_PATH = db.DATA_DIR / "session.key"

# ---------- password hashing ----------

def hash_password(password: str, *, n: int = 2**14, r: int = 8, p: int = 1) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=n, r=r, p=p, dklen=64)
    return f"scrypt${n}${r}${p}${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt_b64, hash_b64 = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(hash_b64)
        dk = hashlib.scrypt(password.encode("utf-8"), salt=base64.b64decode(salt_b64),
                            n=int(n), r=int(r), p=int(p), dklen=len(expected))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(dk, expected)


# ---------- users (cached: checked on every request) ----------

_users_cache: tuple[float, dict[str, dict]] | None = None
USERS_TTL = 5.0
_lock = threading.Lock()


def _users() -> dict[str, dict]:
    global _users_cache
    if _users_cache and time.monotonic() - _users_cache[0] < USERS_TTL:
        return _users_cache[1]
    rows = db.query("SELECT id, login, password, role, disabled FROM app.users")
    users = {r["login"].lower(): r for r in rows}
    _users_cache = (time.monotonic(), users)
    return users


def invalidate_cache() -> None:
    global _users_cache, _sessions_cache
    _users_cache = None
    _sessions_cache = {}


def get_user(login: str) -> dict | None:
    return _users().get((login or "").lower())


def ensure_accounts() -> None:
    """On startup: move the old shared "admin" to "user", make sure an admin exists."""
    with _lock:
        s = db.get_settings()
        if not s.get("accounts_v2"):
            old = db.query_one("SELECT id, role FROM app.users WHERE lower(login) = 'admin'")
            taken = db.query_one("SELECT 1 AS x FROM app.users WHERE lower(login) = %s", (SHARED_LOGIN,))
            if old and (old.get("role") or "user") != "admin" and not taken:
                db.execute("UPDATE app.users SET login = %s, role = 'user', updated_at = now() WHERE id = %s",
                           (SHARED_LOGIN, old["id"]))
                log_event(None, "user_renamed", SHARED_LOGIN, details={"from": "admin"})
            db.set_settings({"accounts_v2": True,
                             "shared_created": bool(old or taken)})
        if not db.query_one("SELECT 1 AS x FROM app.users WHERE role = 'admin' AND NOT disabled"):
            if db.query_one("SELECT 1 AS x FROM app.users WHERE lower(login) = %s", (ADMIN_LOGIN,)):
                db.execute("UPDATE app.users SET role = 'admin', disabled = false WHERE lower(login) = %s",
                           (ADMIN_LOGIN,))
            else:
                db.execute("INSERT INTO app.users(login, password, role) VALUES(%s, %s, 'admin')",
                           (ADMIN_LOGIN, ADMIN_DEFAULT_PASSWORD))
            log_event(None, "user_created", ADMIN_LOGIN, details={"role": "admin", "auto": True})
        invalidate_cache()


def reset_admin() -> None:
    """CLI: restore admin / admin123 and sign everybody out of it."""
    if db.query_one("SELECT 1 AS x FROM app.users WHERE lower(login) = %s", (ADMIN_LOGIN,)):
        db.execute("UPDATE app.users SET password = %s, role = 'admin', disabled = false, updated_at = now() "
                   "WHERE lower(login) = %s", (ADMIN_DEFAULT_PASSWORD, ADMIN_LOGIN))
    else:
        db.execute("INSERT INTO app.users(login, password, role) VALUES(%s, %s, 'admin')",
                   (ADMIN_LOGIN, ADMIN_DEFAULT_PASSWORD))
    end_sessions(ADMIN_LOGIN, "revoked")
    log_event(None, "password_reset", ADMIN_LOGIN, details={"via": "command line"})
    invalidate_cache()


def check_credentials(login: str, password: str) -> dict | None:
    """Returns the user row on success."""
    login = login.strip()
    user = get_user(login)
    if user:
        ok = hmac.compare_digest(password.encode(), (user["password"] or "").encode())
        return user if ok and not user["disabled"] else None
    secrets.compare_digest(password.encode(), secrets.token_hex(16).encode())  # same timing
    # The shared account appears on its first sign-in with the master password (once).
    if login.lower() == SHARED_LOGIN and not db.get_settings().get("shared_created") \
            and verify_password(password, MASTER_HASH):
        db.execute("INSERT INTO app.users(login, password, role) VALUES(%s, %s, 'user') ON CONFLICT DO NOTHING",
                   (SHARED_LOGIN, password))
        db.set_settings({"shared_created": True})
        invalidate_cache()
        return get_user(SHARED_LOGIN)
    return None


# ---------- audit log ----------

def log_event(actor: str | None, action: str, target: str | None = None, *,
              ip: str | None = None, ua: str | None = None, details: dict | None = None) -> None:
    try:
        db.execute(
            "INSERT INTO app.events(actor, action, target, ip, user_agent, details) VALUES(%s, %s, %s, %s, %s, %s)",
            (actor, action, target, ip, (ua or "")[:300] or None, Jsonb(details) if details else None),
        )
    except Exception:  # noqa: BLE001 - the log must never break the action itself
        pass


# ---------- sessions ----------

def _session_key() -> bytes:
    if os.environ.get("SESSION_KEY"):
        return os.environ["SESSION_KEY"].strip().encode()
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not SESSION_KEY_PATH.exists():
        SESSION_KEY_PATH.write_bytes(secrets.token_bytes(32))
    return SESSION_KEY_PATH.read_bytes()


def _sign(payload: str) -> str:
    return hmac.new(_session_key(), payload.encode(), hashlib.sha256).hexdigest()


def _fingerprint(password: str) -> str:
    return hmac.new(_session_key(), b"pw:" + password.encode(), hashlib.sha256).hexdigest()[:16]


def start_session(user: dict, remember: bool, ip: str | None, ua: str | None) -> str:
    """Create a session row and return the signed cookie value."""
    sid = secrets.token_hex(12)
    db.execute("INSERT INTO app.sessions(id, login, ip, user_agent, remember) VALUES(%s, %s, %s, %s, %s)",
               (sid, user["login"], ip, (ua or "")[:300] or None, remember))
    return make_cookie(user, sid, remember)


def make_cookie(user: dict, sid: str, remember: bool) -> str:
    ttl = SESSION_DAYS_REMEMBER * 86400 if remember else SESSION_HOURS_DEFAULT * 3600
    login_b64 = base64.urlsafe_b64encode(user["login"].encode()).decode()
    payload = f"{login_b64}|{int(time.time()) + ttl}|{_fingerprint(user['password'] or '')}|{'r' if remember else 's'}|{sid}"
    token = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{token}.{_sign(payload)}"


# session id -> (checked_at, ended?)
_sessions_cache: dict[str, tuple[float, bool]] = {}
_touched: dict[str, float] = {}


def _session_alive(sid: str) -> bool:
    hit = _sessions_cache.get(sid)
    if hit and time.monotonic() - hit[0] < USERS_TTL:
        return not hit[1]
    row = db.query_one("SELECT ended_at FROM app.sessions WHERE id = %s", (sid,))
    ended = row is None or row["ended_at"] is not None
    if len(_sessions_cache) > 5000:
        _sessions_cache.clear()
    _sessions_cache[sid] = (time.monotonic(), ended)
    return not ended


def parse_session(cookie: str | None) -> dict | None:
    """{"login", "role", "remember", "sid"} if the cookie is valid, else None."""
    if not cookie or "." not in cookie:
        return None
    token, sig = cookie.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(token.encode()).decode()
        login_b64, expires, fingerprint, flag, sid = payload.split("|")
        login = base64.urlsafe_b64decode(login_b64.encode()).decode()
        expires_at = int(expires)
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(sig, _sign(payload)) or expires_at < time.time():
        return None
    user = get_user(login)
    if not user or user["disabled"] or not hmac.compare_digest(fingerprint, _fingerprint(user["password"] or "")):
        return None
    if not _session_alive(sid):
        return None
    return {"login": user["login"], "role": user["role"], "remember": flag == "r", "sid": sid}


def touch(sid: str) -> None:
    """Record activity (at most once a minute per session)."""
    now = time.monotonic()
    if now - _touched.get(sid, 0) < TOUCH_EVERY:
        return
    _touched[sid] = now
    if len(_touched) > 5000:
        _touched.clear()
    db.execute("UPDATE app.sessions SET last_seen_at = now() WHERE id = %s AND ended_at IS NULL", (sid,))


def end_session(sid: str, reason: str) -> None:
    db.execute("UPDATE app.sessions SET ended_at = now(), end_reason = %s WHERE id = %s AND ended_at IS NULL",
               (reason, sid))
    _sessions_cache.pop(sid, None)


def end_sessions(login: str, reason: str, except_sid: str | None = None) -> int:
    n = db.execute(
        "UPDATE app.sessions SET ended_at = now(), end_reason = %s "
        "WHERE lower(login) = lower(%s) AND ended_at IS NULL AND id IS DISTINCT FROM %s",
        (reason, login, except_sid),
    )
    _sessions_cache.clear()
    return n


# ---------- brute-force protection ----------

@dataclass
class _Attempts:
    fails: int = 0
    locked_until: float = 0.0


FREE_ATTEMPTS = 5
_attempts: dict[str, _Attempts] = defaultdict(_Attempts)


def lock_remaining(ip: str) -> int:
    return max(0, int(_attempts[ip].locked_until - time.time() + 0.999))


def register_failure(ip: str) -> int:
    """Count a failed login; returns lock seconds (0 if not locked yet)."""
    if len(_attempts) > 5000:  # don't let the table grow without bound
        now = time.time()
        for key in [k for k, v in _attempts.items() if v.locked_until < now]:
            del _attempts[key]
    a = _attempts[ip]
    a.fails += 1
    if a.fails >= FREE_ATTEMPTS:
        # 30 s, 60 s, 2 min, 4 min ... up to 30 min
        lock = min(30 * 2 ** (a.fails - FREE_ATTEMPTS), 1800)
        a.locked_until = time.time() + lock
        return lock
    return 0


def register_success(ip: str) -> None:
    _attempts.pop(ip, None)
