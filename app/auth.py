"""Login with a single master account.

* Password hashes use scrypt; the plain password is never stored anywhere.
* The default account (admin) ships as a hash only. It can be changed in Settings;
  the new hash is stored in the local database and overrides the default.
* Sessions are HMAC-signed cookies (HttpOnly, SameSite=Lax). Changing the password
  bumps a version number, which logs out every existing session.
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
SESSION_DAYS_REMEMBER = 30
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


# ---------- account ----------

def account() -> dict:
    s = db.get_settings()
    return {
        "login": s.get("auth_login") or DEFAULT_LOGIN,
        "hash": s.get("auth_hash") or DEFAULT_HASH,
        "version": int(s.get("auth_version") or 1),
    }


def check_credentials(login: str, password: str) -> bool:
    acc = account()
    login_ok = hmac.compare_digest(login.strip().lower().encode(), acc["login"].lower().encode())
    password_ok = verify_password(password, acc["hash"])  # always run: same timing for wrong logins
    return login_ok and password_ok


def change_credentials(new_login: str, new_password: str) -> None:
    acc = account()
    db.set_settings({
        "auth_login": new_login.strip(),
        "auth_hash": hash_password(new_password),
        "auth_version": acc["version"] + 1,
    })


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


def make_session(remember: bool) -> tuple[str, int]:
    """Returns (cookie value, max-age seconds)."""
    ttl = SESSION_DAYS_REMEMBER * 86400 if remember else SESSION_HOURS_DEFAULT * 3600
    acc = account()
    payload = f"{acc['login']}|{int(time.time()) + ttl}|{acc['version']}|{secrets.token_hex(8)}"
    token = base64.urlsafe_b64encode(payload.encode()).decode()
    return f"{token}.{_sign(payload)}", ttl


def read_session(cookie: str | None) -> str | None:
    """Login name if the cookie is valid, else None."""
    if not cookie or "." not in cookie:
        return None
    token, sig = cookie.rsplit(".", 1)
    try:
        payload = base64.urlsafe_b64decode(token.encode()).decode()
        login, expires, version, _ = payload.split("|")
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(sig, _sign(payload)):
        return None
    acc = account()
    if int(expires) < time.time() or int(version) != acc["version"] or login != acc["login"]:
        return None
    return login


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
