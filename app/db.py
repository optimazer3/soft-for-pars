"""SQLite storage: clients, snapshots of collected data and app settings."""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime
from pathlib import Path
from typing import Any

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "optimizer.db"

_lock = threading.RLock()
_conn: sqlite3.Connection | None = None

SCHEMA = """
CREATE TABLE IF NOT EXISTS clients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    base_url      TEXT NOT NULL,
    login         TEXT NOT NULL,
    password_enc  TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    notes         TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    last_sync_at  TEXT,
    last_status   TEXT NOT NULL DEFAULT 'never',
    last_error    TEXT
);

-- One row per client per day: the latest successful collection of that day.
CREATE TABLE IF NOT EXISTS snapshots (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id          INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    day                TEXT NOT NULL,
    period             TEXT NOT NULL,
    fetched_at         TEXT NOT NULL,
    source_updated_at  TEXT,
    kpi_json           TEXT NOT NULL,
    branches_json      TEXT NOT NULL,
    UNIQUE (client_id, day)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_client ON snapshots(client_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

DEFAULT_SETTINGS: dict[str, Any] = {
    "schedule_enabled": True,
    "schedule_times": ["09:00", "14:00", "19:00"],
    "concurrency": 5,
    "last_scheduled_run": None,
}


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        c = sqlite3.connect(DB_PATH, check_same_thread=False)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA foreign_keys=ON")
        c.executescript(SCHEMA)
        _conn = c
    return _conn


def query(sql: str, params: tuple | dict = ()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, params).fetchall()]


def query_one(sql: str, params: tuple | dict = ()) -> dict | None:
    rows = query(sql, params)
    return rows[0] if rows else None


def execute(sql: str, params: tuple | dict = ()) -> int:
    """Run a write statement, commit, return lastrowid."""
    with _lock:
        c = conn()
        cur = c.execute(sql, params)
        c.commit()
        return cur.lastrowid


# ---------- settings ----------

def get_settings() -> dict[str, Any]:
    stored = {r["key"]: json.loads(r["value"]) for r in query("SELECT key, value FROM settings")}
    return {**DEFAULT_SETTINGS, **stored}


def set_settings(values: dict[str, Any]) -> dict[str, Any]:
    with _lock:
        c = conn()
        for k, v in values.items():
            c.execute(
                "INSERT INTO settings(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (k, json.dumps(v, ensure_ascii=False)),
            )
        c.commit()
    return get_settings()


# ---------- snapshots ----------

def save_snapshot(client_id: int, period: str, source_updated_at: str | None,
                  kpi: dict, branches: list[dict]) -> None:
    ts = now_iso()
    execute(
        """
        INSERT INTO snapshots(client_id, day, period, fetched_at, source_updated_at, kpi_json, branches_json)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(client_id, day) DO UPDATE SET
            period = excluded.period,
            fetched_at = excluded.fetched_at,
            source_updated_at = excluded.source_updated_at,
            kpi_json = excluded.kpi_json,
            branches_json = excluded.branches_json
        """,
        (client_id, ts[:10], period, ts, source_updated_at,
         json.dumps(kpi, ensure_ascii=False), json.dumps(branches, ensure_ascii=False)),
    )


def latest_snapshot(client_id: int) -> dict | None:
    row = query_one(
        "SELECT * FROM snapshots WHERE client_id = ? ORDER BY fetched_at DESC LIMIT 1",
        (client_id,),
    )
    if row:
        row["kpi"] = json.loads(row.pop("kpi_json"))
        row["branches"] = json.loads(row.pop("branches_json"))
    return row
