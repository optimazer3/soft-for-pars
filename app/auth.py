"""Login for the dashboard.

* Users live in the table app.users (login + password in plain text, as requested by the owner),
  so they can be added or edited directly in Supabase.
* Until the table has a user, the built-in account "admin" with the master password works
  (only its scrypt hash is in the code). The first successful login stores it in app.users.
* Sessions are HMAC-signed cookies (HttpOnly, SameSite=Lax). The cookie carries a fingerprint
  of the user's password, so changing the password — in Settings or directly in the database —
  logs out every existing session of that user. Deleting the user logs them out too.
* Brute-force protection: after a few wrong attempts from one IP the login is locked
  for a growing period.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict
from dataclasses import dataclass

from . import db

COOKIE_NAME = "od_session"
# "Remember me" = stay signed in for good: the token is valid for 10 years and the cookie
# (browsers cap cookie lifetime at ~400 days) is renewed on every visit.
SESSION_DAYS_REMEMBER = 3650
COOKIE_MAX_AGE = 400 * 86400
SESSION_HOURS_DEFAULT = 12

DEFAULT_LOGIN = "admin"
# scrypt hash of the master password given by the owner (the password itself is not in the code).
DEFAULT_HASH = (
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


def _users() -> dict[str, dict]:
    global _users_cache
    if _users_cache and time.monotonic() - _users_cache[0] < USERS_TTL:
        return _users_cache[1]
    users = {r["login"].lower(): r for r in db.query("SELECT id, login, password FROM app.users")}
    _users_cache = (time.monotonic(), users)
    return users


def invalidate_cache() -> None:
    global _users_cache
    _users_cache = None


def check_credentials(login: str, password: str) -> str | None:
    """Returns the canonical login on success."""
    login = login.strip()
    users = _users()
    if users:
        user = users.get(login.lower())
        stored = user["password"] if user else secrets.token_hex(16)  # same timing for unknown logins
        if hmac.compare_digest(password.encode(), stored.encode()) and user:
            return user["login"]
        return None
    # No users yet: the built-in master account (or the one changed in Settings by an older
    # version, stored as a hash). On success it is saved to app.users in plain text.
    st = db.get_settings()
    base_login = st.get("auth_login") or DEFAULT_LOGIN
    if login.lower() == base_login.lower() and verify_password(password, st.get("auth_hash") or DEFAULT_HASH):
        db.execute("INSERT INTO app.users(login, password) VALUES(%s, %s) ON CONFLICT DO NOTHING",
                   (base_login, password))
        db.delete_settings(["auth_login", "auth_hash", "auth_version"])
        invalidate_cache()
        return base_login
    return None


def current_password(login: str) -> str | None:
    user = _users().get(login.lower())
    return user["password"] if user else None


def change_credentials(old_login: str, new_login: str, new_password: str) -> None:
    new_login = new_login.strip()
    other = _users().get(new_login.lower())
    if other and other["login"].lower() != old_login.lower():
        raise ValueError("Такой логин уже занят")
    db.execute("UPDATE app.users SET login = %s, password = %s, updated_at = now() WHERE lower(login) = lower(%s)",
               (new_login, new_password, old_login))
    invalidate_cache()


# ---------- sessions (signed cookies) ----------

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


def make_session(login: str, remember: bool) -> str:
    """Signed cookie value: login | expiry | password fingerprint | remember flag | nonce."""
    ttl = SESSION_DAYS_REMEMBER * 86400 if remember else SESSION_HOURS_DEFAULT * 3600
    pw = current_password(login) or ""
    login_b64 = base64.urlsafe_b64encode(login.encode()).decode()
    payload = (f"{login_b64}|{int(time.time()) + ttl}|{_fingerprint(pw)}|"
               f"{'r' if remember else 's'}|{secrets.token_hex(8)}")
    token = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{token}.{_sign(payload)}"


def parse_session(cookie: str | None) -> tuple[str, bool] | None:
    """(login, remember) if the cookie is valid, else None."""
    if not cookie or "." not in cookie:
        return None
    token, sig = cookie.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(token.encode()).decode()
        login_b64, expires, fingerprint, flag, _ = payload.split("|")
        login = base64.urlsafe_b64decode(login_b64.encode()).decode()
        expires_at = int(expires)
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(sig, _sign(payload)) or expires_at < time.time():
        return None
    pw = current_password(login)
    if pw is None or not hmac.compare_digest(fingerprint, _fingerprint(pw)):
        return None
    return login, flag == "r"


def read_session(cookie: str | None) -> str | None:
    """Login name if the cookie is valid, else None."""
    parsed = parse_session(cookie)
    return parsed[0] if parsed else None


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
