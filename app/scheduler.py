"""Runs the collection at the configured times of day (local time of the computer).

If the computer was asleep or the app was closed at a scheduled time, the missed
run happens as soon as the app is running again.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta

from . import db
from .collector import collector

log = logging.getLogger("scheduler")
TICK_SECONDS = 20


def _parse_times(times: list[str]) -> list[tuple[int, int]]:
    out = []
    for t in times or []:
        try:
            h, m = (int(x) for x in str(t).split(":"))
        except ValueError:
            continue
        if 0 <= h < 24 and 0 <= m < 60:
            out.append((h, m))
    return sorted(set(out))


def latest_due_slot(times: list[str], now: datetime) -> datetime | None:
    slots = _parse_times(times)
    if not slots:
        return None
    for day_offset in (0, 1):
        day = (now - timedelta(days=day_offset)).date()
        for h, m in reversed(slots):
            slot = datetime(day.year, day.month, day.day, h, m, tzinfo=now.tzinfo)
            if slot <= now:
                return slot
    return None


def next_slot(times: list[str], now: datetime) -> datetime | None:
    slots = _parse_times(times)
    for day_offset in (0, 1):
        day = (now + timedelta(days=day_offset)).date()
        for h, m in slots:
            slot = datetime(day.year, day.month, day.day, h, m, tzinfo=now.tzinfo)
            if slot > now:
                return slot
    return None


async def scheduler_loop() -> None:
    while True:
        try:
            s = await asyncio.to_thread(db.get_settings)
            if s.get("schedule_enabled"):
                now = datetime.now().astimezone()
                due = latest_due_slot(s.get("schedule_times", []), now)
                last = s.get("last_scheduled_run")
                last_dt = datetime.fromisoformat(last) if last else None
                if due and (last_dt is None or last_dt < due) and not collector.state.running:
                    log.info("scheduled run for slot %s", due.isoformat())
                    await asyncio.to_thread(db.set_settings, {"last_scheduled_run": now.isoformat(timespec="seconds")})
                    await collector.sync_all(trigger="schedule")
        except Exception:  # noqa: BLE001 - the loop must never die
            log.exception("scheduler tick failed")
        await asyncio.sleep(TICK_SECONDS)
