"""One-time move of data from the old local SQLite file (data/optimizer.db) to Postgres/Supabase.

Run:  python run.py --import-sqlite   (or start.bat --import-sqlite)

Safe to run more than once: existing rows are left untouched.
Client passwords are decrypted with data/secret.key and stored in plain text.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

from psycopg.types.json import Jsonb

from . import db
from .crypto import decrypt


def _ts(v):
    return datetime.fromisoformat(v) if isinstance(v, str) and v else None


def _plain(r: dict) -> str | None:
    if r.get("password"):
        return r["password"]
    try:
        return decrypt(r["password_enc"])
    except Exception:  # noqa: BLE001 - no key: the password has to be entered again
        print(f"  Клиент «{r['name']}»: пароль не расшифрован (нет data/secret.key) — укажите его заново.")
        return None


def import_sqlite(path: str) -> None:
    src_path = Path(path)
    if not src_path.exists():
        print(f"  Файл {src_path} не найден — переносить нечего.")
        return
    src = sqlite3.connect(src_path)
    src.row_factory = sqlite3.Row
    tables = {r[0] for r in src.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}

    clients = [dict(r) for r in src.execute("SELECT * FROM clients")] if "clients" in tables else []
    settings = [dict(r) for r in src.execute("SELECT * FROM settings")] if "settings" in tables else []
    snapshots = []
    if "snapshots" in tables:
        retention = int(db.get_settings().get("snapshot_retention_days") or 7)
        snapshots = [dict(r) for r in src.execute(
            "SELECT * FROM snapshots s WHERE s.day >= date('now', ?) "
            "OR s.fetched_at = (SELECT MAX(fetched_at) FROM snapshots n WHERE n.client_id = s.client_id)",
            (f"-{retention} days",),
        )]

    added = {"clients": 0, "snapshots": 0, "settings": 0}
    with db.pool().connection() as c, c.transaction():
        for r in clients:
            cur = c.execute(
                """
                INSERT INTO app.clients(id, name, base_url, login, password, enabled, notes,
                                    created_at, updated_at, last_sync_at, last_status, last_error)
                VALUES(%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (id) DO NOTHING
                """,
                (r["id"], r["name"], r["base_url"], r["login"], _plain(r), bool(r["enabled"]),
                 r.get("notes") or "", _ts(r["created_at"]) or db.now(), _ts(r["updated_at"]) or db.now(),
                 _ts(r.get("last_sync_at")),
                 "error" if r.get("last_status") == "running" else (r.get("last_status") or "never"),
                 r.get("last_error")),
            )
            added["clients"] += cur.rowcount
        c.execute("SELECT setval(pg_get_serial_sequence('app.clients', 'id'), "
                  "GREATEST((SELECT COALESCE(MAX(id), 0) FROM app.clients), 1))")

        for r in snapshots:
            progress = r.get("progress_json")
            cur = c.execute(
                """
                INSERT INTO app.snapshots(client_id, day, period, fetched_at, source_updated_at, kpi, branches, progress)
                VALUES(%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (client_id, day) DO NOTHING
                """,
                (r["client_id"], r["day"], r["period"], _ts(r["fetched_at"]), r.get("source_updated_at"),
                 Jsonb(json.loads(r["kpi_json"])), Jsonb(json.loads(r["branches_json"])),
                 Jsonb(json.loads(progress)) if progress else None),
            )
            added["snapshots"] += cur.rowcount

        for r in settings:
            cur = c.execute(
                "INSERT INTO app.settings(key, value) VALUES(%s, %s) ON CONFLICT (key) DO NOTHING",
                (r["key"], Jsonb(json.loads(r["value"]))),
            )
            added["settings"] += cur.rowcount

    print(f"  Перенесено: клиентов {added['clients']} из {len(clients)}, "
          f"снимков {added['snapshots']} из {len(snapshots)}, настроек {added['settings']} из {len(settings)}.")
    print("  Старый файл не тронут. Когда убедитесь, что всё на месте, его можно удалить.")
