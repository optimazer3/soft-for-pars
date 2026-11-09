"""Encryption of client passwords at rest.

The key is generated on first run and stored in data/secret.key (or given as SECRET_KEY).
Only ciphertext goes to the database; without this key saved passwords cannot be decrypted.
"""
from __future__ import annotations

import os
from functools import lru_cache

from cryptography.fernet import Fernet

from .db import DATA_DIR

KEY_PATH = DATA_DIR / "secret.key"


@lru_cache(maxsize=1)
def _fernet() -> Fernet:
    # On a server the key can come from the environment instead of a file.
    if os.environ.get("SECRET_KEY"):
        return Fernet(os.environ["SECRET_KEY"].strip().encode())
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if not KEY_PATH.exists():
        KEY_PATH.write_bytes(Fernet.generate_key())
    return Fernet(KEY_PATH.read_bytes().strip())


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode("utf-8")).decode("ascii")


def decrypt(token: str) -> str:
    return _fernet().decrypt(token.encode("ascii")).decode("utf-8")
