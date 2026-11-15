"""Rebuild the figures the Optimizer API can substantiate for a past date."""

from calendar import monthrange
from datetime import date, datetime, timedelta

from .optimizer import OptimizerClient

ORDER_METRICS = ("sales_amount", "vtl_orders_count")
DAILY_TASKS = {"tasks_created", "analysis_tasks"}
WEEKLY_TASKS = ("tasks_prev", "tasks")


def orders_missing(snapshot: dict) -> bool:
    return not snapshot.get("progress") or any(
        ((snapshot.get("kpi") or {}).get(key) or {}).get("current") is None for key in ORDER_METRICS
    )


def local_day(value: str, at: datetime) -> date:
    timestamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return timestamp.astimezone(at.tzinfo).date() if timestamp.tzinfo else timestamp.date()


def order_metrics(totals: dict, plans: dict | None) -> dict:
    return {
        key: {"current": totals[key], "plan": ((plans or {}).get(key) or {}).get("plan")}
        for key in ORDER_METRICS if key in totals
    }


def progress(day: date, facts: dict, plan: dict | None) -> dict | None:
    fact = (facts.get("sales_amount") or {}).get("current")
    amount = (plan or {}).get("plan_amount")
    if fact is None or amount is None:
        return None
    elapsed = day.day / monthrange(day.year, day.month)[1]
    execution = 100 * fact / amount if amount > 0 else None
    return {
        "plan_amount": amount, "fact_amount": fact, "progress_percent": round(100 * elapsed, 1),
        "execution_percent": round(execution, 1) if execution is not None else None,
        "forecast_percent": round(execution / elapsed, 1) if execution is not None else None,
    }


async def historical_week(data: dict, at: datetime) -> dict:
    tasks = {task["id"]: task for day in data["days"] for task in day["tasks"]
             if local_day(task["created_at"], at) <= at.date()}
    status_known = all(task.get("updated_at") and local_day(task["updated_at"], at) <= at.date()
                       for task in tasks.values())
    return {
        "week_start": data["week_start"], "label": data.get("week_label"), "total": len(tasks),
        "done": sum(task["status"] == "completed" for task in tasks.values()) if status_known else None,
    }


async def historical_activity(client: OptimizerClient, day: date, today: date) -> dict | None:
    monday = day - timedelta(days=day.weekday())
    previous = monday - timedelta(days=7)
    days = (today - previous).days + 1
    if days > 90:
        return None
    data = await client._get_json("/api/activity/weekly", {"granularity": "day", "days": max(14, days)})
    dates = data["period"]["weeks"]
    totals = {
        date.fromisoformat(key): sum(float(row["weeks"][i].get("minutes") or 0) for row in data["rows"])
        for i, key in enumerate(dates)
    }

    def hours(start: date, length: int) -> float | None:
        values = [totals.get(start + timedelta(days=i)) for i in range(length)]
        return round(sum(values) / 60, 1) if all(value is not None for value in values) else None

    hours_now, hours_prev = hours(monday, day.weekday() + 1), hours(previous, 7)
    if hours_now is None and hours_prev is None:
        return None
    return {"week_start": monday.isoformat(), "prev_week_start": previous.isoformat(),
            "hours": hours_now, "prev_hours": hours_prev}


async def historical_badges(client: OptimizerClient, at: datetime) -> dict | None:
    day = at.date()
    badges = await client._get_json("/api/badges", {"include_inactive": "true"})
    inventory = [badge for badge in badges["badges"] if local_day(badge["created_at"], at) <= day]
    if any(badge.get("updated_at") and local_day(badge["updated_at"], at) > day for badge in inventory):
        return None
    active = {badge["id"] for badge in inventory if badge["is_active"]}
    assignments = await client._get_json("/api/badge-assignments", {"date_to": day.isoformat()})
    issued = {
        row["badge_id"] for row in assignments["assignments"]
        if date.fromisoformat(row["assignment_date"][:10]) <= day
        and (not row.get("return_date") or date.fromisoformat(row["return_date"][:10]) > day)
    }
    return {"issued": len(issued & active), "total": len(active)}


async def historical_orders(client: OptimizerClient, day: date, branches: list[dict]) -> dict:
    start = day.replace(day=1)
    sales = await client._get_json("/api/sales", {"start_date": start.isoformat(), "end_date": day.isoformat()})
    totals = sales["branch_totals"]
    if not totals:
        return {}
    period = day.strftime("%Y-%m")
    overall_plans = await client._optional(client.kpi(period))
    overall_plan = await client.monthly_progress(period)
    sum_totals = {key: sum(row[key] for row in totals.values()) for key in ORDER_METRICS
                  if all(key in row for row in totals.values())}
    kpi = order_metrics(sum_totals, overall_plans)
    rows = []
    for branch in branches:
        row = {**branch, "kpi": None, "progress": None}
        if branch["name"] in totals:
            ids = [branch["id"]]
            plans = await client._optional(client.kpi(period, ids))
            row["kpi"] = order_metrics(totals[branch["name"]], plans)
            row["progress"] = progress(day, row["kpi"], await client.monthly_progress(period, ids))
        rows.append(row)
    return {"kpi": kpi, "progress": progress(day, kpi, overall_plan), "branches": rows}


async def collect_history(client: OptimizerClient, at: datetime, today: date, *, snapshot: dict | None,
                          has_signals: bool) -> tuple[dict, dict | None]:
    await client.login()
    day = at.date()
    branches = await client.branches()
    signals = None if has_signals else await client.collect_daily_signals(day, branches=branches)
    recorded = snapshot or {}
    available = {key for key, value in (recorded.get("extras") or {}).items() if value is not None}
    extras = {}
    if not (DAILY_TASKS | set(WEEKLY_TASKS)) <= available:
        monday = day - timedelta(days=day.weekday())
        weeks = [await client._optional(client.tasks_week(monday + timedelta(days=offset))) for offset in (-7, 0)]
        if not DAILY_TASKS <= available:
            weeks.append(await client._optional(client.tasks_week(monday + timedelta(days=7))))
            extras.update((await client._optional(client.daily_tasks(at, weeks))) or {})
        for source, key in zip(weeks, WEEKLY_TASKS):
            if key not in available and source is not None:
                extras[key] = await client._optional(historical_week(source, at))
    if "activity" not in available:
        extras["activity"] = await client._optional(historical_activity(client, day, today))
    if "badges" not in available:
        extras["badges"] = await client._optional(historical_badges(client, at))
    orders = await client._optional(historical_orders(client, day, branches)) if orders_missing(recorded) else None
    return {**(orders or {}), "extras": extras, "full": snapshot is None}, signals
