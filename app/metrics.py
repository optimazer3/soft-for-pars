"""Manual values layered over the imported figures for one project and day."""

from copy import deepcopy
from datetime import date
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

from .db import signals_complete
from .history import DAILY_TASKS, WEEKLY_TASKS, orders_missing

Number = Annotated[float, Field(ge=0, le=1e15, allow_inf_nan=False)]
Count = Annotated[int, Field(ge=0, le=1_000_000_000)]


class MetricOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid")

    sales_execution: Number | None = None
    sales_forecast: Number | None = None
    sales_fact: Number | None = None
    sales_plan: Number | None = None
    orders_amount: Number | None = None
    orders_plan: Number | None = None
    vtl_count: Count | None = None
    vtl_plan: Count | None = None
    activity_hours: Number | None = None
    previous_activity_hours: Number | None = None
    tasks_done: Count | None = None
    tasks_total: Count | None = None
    previous_tasks_done: Count | None = None
    previous_tasks_total: Count | None = None
    badges_issued: Count | None = None
    badges_total: Count | None = None
    tasks_created: Count | None = None
    signals_done: Count | None = None
    signals_total: Count | None = None
    analysis_tasks: Count | None = None


METRIC_PATHS = {
    "sales_execution": ("progress", "execution_percent"),
    "sales_forecast": ("progress", "forecast_percent"),
    "sales_fact": ("progress", "fact_amount"),
    "sales_plan": ("progress", "plan_amount"),
    "orders_amount": ("kpi", "sales_amount", "current"),
    "orders_plan": ("kpi", "sales_amount", "plan"),
    "vtl_count": ("kpi", "vtl_orders_count", "current"),
    "vtl_plan": ("kpi", "vtl_orders_count", "plan"),
    "activity_hours": ("extras", "activity", "hours"),
    "previous_activity_hours": ("extras", "activity", "prev_hours"),
    "tasks_done": ("extras", "tasks", "done"),
    "tasks_total": ("extras", "tasks", "total"),
    "previous_tasks_done": ("extras", "tasks_prev", "done"),
    "previous_tasks_total": ("extras", "tasks_prev", "total"),
    "badges_issued": ("extras", "badges", "issued"),
    "badges_total": ("extras", "badges", "total"),
    "tasks_created": ("extras", "tasks_created"),
    "signals_done": ("extras", "signals", "done"),
    "signals_total": ("extras", "signals", "total"),
    "analysis_tasks": ("extras", "analysis_tasks"),
}


def needs_report(snapshot: dict | None, signals: dict | None, archive: dict | None) -> bool:
    if archive is not None and (snapshot or archive.get("full")):
        return False
    recorded = snapshot or {}
    extras = recorded.get("extras") or {}
    required = DAILY_TASKS | set(WEEKLY_TASKS) | {"activity", "badges"}
    return orders_missing(recorded) or not signals_complete(signals) or any(extras.get(key) is None for key in required)


def display_snapshot(snapshot: dict | None, signals: dict | None, override: dict | None, day: date,
                     archive: dict | None = None) -> dict | None:
    archive = archive or {}
    archived_extras = {key: value for key, value in archive.get("extras", {}).items() if value is not None}
    has_history = bool(archive.get("kpi") or archived_extras)
    if not (snapshot or signals or override or has_history):
        return None
    result = deepcopy(snapshot) if snapshot else {
        "day": day, "period": None, "fetched_at": None, "source_updated_at": None,
        "kpi": {}, "branches_count": 0,
    }
    if snapshot:
        for key, value in (archive.get("kpi") or {}).items():
            if (result["kpi"].get(key) or {}).get("current") is None:
                result["kpi"][key] = deepcopy(value)
        if not result.get("progress") and archive.get("progress"):
            result["progress"] = deepcopy(archive["progress"])
        if result.get("branches") and archive.get("branches"):
            branches = {branch["id"]: branch for branch in archive["branches"]}
            for branch in result["branches"]:
                restored = branches.get(branch["id"], {})
                for key in ("kpi", "progress"):
                    if not branch.get(key) and restored.get(key):
                        branch[key] = deepcopy(restored[key])
    elif has_history:
        branches = deepcopy(archive.get("branches") or [])
        result.update(period=day.strftime("%Y-%m"), kpi=deepcopy(archive.get("kpi") or {}),
                      progress=deepcopy(archive.get("progress")), branches=branches,
                      branches_count=len(branches), reconstructed=True)
    recorded_extras = result.get("extras") or {}
    extras = result["extras"] = {**deepcopy(archived_extras), **{
        key: value for key, value in recorded_extras.items() if value is not None
    }}
    if result["day"] != day:
        extras.pop("tasks_created", None)
        extras.pop("analysis_tasks", None)
    if signals:
        counts = signals["counts"]
        branch_counts = counts["branches"]
        extras["signals"] = {
            "day": signals["day"], "reported": len(branch_counts), "expected": counts["expected"],
            **{key: sum(row[key] for row in branch_counts.values()) for key in ("done", "total")},
        }
        if result.get("branches"):
            for branch in result["branches"]:
                branch["signals"] = branch_counts.get(branch["id"])
        elif not snapshot:
            result["branches_count"] = counts["expected"]
            result["branches"] = [
                {"id": branch_id, "name": row["name"], "signals": row}
                for branch_id, row in branch_counts.items() if "name" in row
            ]
    override = override or {}
    # A manual change is dated. Use the latest imported figures as the live baseline.
    if signals and signals["day"] != day and {"signals_done", "signals_total"}.intersection(override):
        del extras["signals"]
    original = {}
    for field, path in METRIC_PATHS.items():
        cursor = result
        for key in path:
            cursor = (cursor or {}).get(key)
        original[field] = cursor
    result["metric_values"] = original
    result["metric_overrides"] = override
    for field, value in override.items():
        if field not in METRIC_PATHS:
            continue
        *sections, key = METRIC_PATHS[field]
        target = result
        for section in sections:
            if target.get(section) is None:
                target[section] = {}
            target = target[section]
        target[key] = value
    if {"signals_done", "signals_total"}.intersection(override):
        extras["signals"]["day"] = day
    for key, fields in (("sales_amount", {"orders_amount", "orders_plan"}), ("vtl_orders_count", {"vtl_count", "vtl_plan"})):
        metric = result["kpi"].get(key)
        if metric and fields.intersection(override):
            current, plan = metric.get("current"), metric.get("plan")
            execution = 100 * current / plan if current is not None and plan else None
            metric["execution"] = execution
            metric["status"] = (
                "neutral" if execution is None else "excellent" if execution >= 100 else "good" if execution >= 90 else "poor"
            )
    return result
