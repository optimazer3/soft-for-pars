// Client summary: the nine figures the dashboard is about.
//   plan execution · forecast · total orders · VTL orders · activity (hours)
//   tasks of the previous week · tasks of the current week · badges · data date
import { formatValue, metricStatus } from "./metrics.js";
import { fmtDay, html } from "./ui.js";
import { forecastDelta, forecastStatus } from "./plan.js";

const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));
const pct = (done, total) => (total ? (done / total) * 100 : 0);
const MONTHS_GEN = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/** "2 - 8 ноября 2026" -> "2–8 ноября" (fallback: from the week start). */
export function weekLabel(t) {
  if (t?.label) return t.label.replace(/\s*\d{4}\s*$/, "").replace(/\s*-\s*/, "–");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t?.week_start || "");
  if (!m) return "";
  const start = new Date(+m[1], +m[2] - 1, +m[3]);
  const end = new Date(start); end.setDate(start.getDate() + 6);
  return start.getMonth() === end.getMonth()
    ? `${start.getDate()}–${end.getDate()} ${MONTHS_GEN[end.getMonth()]}`
    : `${start.getDate()} ${MONTHS_GEN[start.getMonth()]} – ${end.getDate()} ${MONTHS_GEN[end.getMonth()]}`;
}

/** Share of finished tasks of a closed week: good / so-so / poor. */
export function tasksStatus(t) {
  if (!t || !t.total) return "neutral";
  const p = pct(t.done, t.total);
  return p >= 90 ? "excellent" : p >= 70 ? "good" : "poor";
}

const count = (v, kind, prev) => html`<span data-count="${v}" data-kind="${kind}" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(v, kind)}</span>`;
const empty = (label, i) => html`<div class="tile neutral empty" style="--i:${i}"><div class="tile-label">${label}</div>
  <div class="tile-value">—</div><div class="tile-foot"><span>Нет данных</span></div></div>`;

function kpiTile(label, m, kind, i, prev) {
  if (!m) return empty(label, i);
  const st = metricStatus(m);
  return html`<div class="tile ${st}" style="--i:${i}">
    <div class="tile-label">${label}</div>
    <div class="tile-value">${count(m.current, kind, prev)}</div>
    <div class="tile-foot"><span>План ${m.plan ? formatValue(m.plan, kind) : "—"}</span>
      ${m.plan ? html`<span class="tile-exec"><span class="dot ${st}"></span>${formatValue(m.execution, "percent")}</span>` : ""}</div>
    <div class="meter"><i style="--w:${m.plan ? clamp(m.execution) : 0}%"></i></div>
  </div>`;
}

function ratioTile(label, x, i, { status = "accent", foot = "", prev } = {}) {
  if (!x) return empty(label, i);
  return html`<div class="tile ${status}" style="--i:${i}">
    <div class="tile-label">${label}</div>
    <div class="tile-value">${count(x.done, "count", prev)}<span class="of"> / ${x.total}</span></div>
    <div class="tile-foot"><span>${foot}</span>${x.total ? html`<span class="tile-exec">${formatValue(Math.round(pct(x.done, x.total)), "percent")}</span>` : ""}</div>
    <div class="meter"><i style="--w:${clamp(pct(x.done, x.total))}%"></i></div>
  </div>`;
}

function activityTile(a, i, prev) {
  if (!a) return empty("Активность", i);
  const main = a.prev_hours ?? a.hours;
  return html`<div class="tile accent" style="--i:${i}">
    <div class="tile-label">Активность</div>
    <div class="tile-value">${count(main, "count", prev)}<span class="of"> ч</span></div>
    <div class="tile-foot"><span>${a.prev_hours != null ? "за прошлую неделю" : "за эту неделю"}</span>
      ${a.prev_hours != null ? html`<span class="tile-exec" title="Эта неделя, пока не закончилась">сейчас ${formatValue(a.hours, "count")} ч</span>` : ""}</div>
  </div>`;
}

function planBlock(p, prev) {
  if (!p) {
    return html`<div class="plan-block empty"><div class="pb-label">План продаж на очки</div><div class="pb-value">—</div>
      <div class="tile-foot"><span>Нет данных</span></div></div>`;
  }
  const delta = forecastDelta(p);
  const fs = forecastStatus(p.forecast_percent);
  return html`<div class="plan-block" title="Отметка на шкале — сколько месяца уже прошло">
    <div class="pb-row">
      <div>
        <div class="pb-label">Выполнение плана продаж</div>
        <div class="pb-value">${count(p.execution_percent, "percent", prev?.execution_percent)}</div>
      </div>
      <div class="pb-forecast">
        <div class="pb-label">Прогноз на конец месяца</div>
        <div class="pb-value ${fs}">${count(p.forecast_percent, "percent", prev?.forecast_percent)}</div>
      </div>
    </div>
    <div class="plan-meter" style="--w:${clamp(p.execution_percent)}%;--m:${clamp(p.progress_percent)}%"><i></i><span class="marker"></span></div>
    <div class="tile-foot">
      <span>${p.plan_amount ? html`${formatValue(p.fact_amount, "money")} из ${formatValue(p.plan_amount, "money")}` : ""}</span>
      ${delta !== null ? html`<span class="delta ${delta >= 0 ? "pos" : "neg"}">${delta >= 0 ? "+" : "−"}${formatValue(Math.abs(Math.round(delta)), "money")}</span>` : ""}
    </div>
  </div>`;
}

/** Tiles without the plan block (client page shows the plan as a banner). */
export function summaryTiles(s, prev, start = 0) {
  const x = s.extras || {};
  const px = prev?.extras || {};
  let i = start;
  return [
    kpiTile("Итого сумма заказов", s.kpi?.sales_amount, "money", i++, prev?.kpi?.sales_amount?.current),
    kpiTile("Заказы ВТЛ", s.kpi?.vtl_orders_count, "count", i++, prev?.kpi?.vtl_orders_count?.current),
    activityTile(x.activity, i++, px.activity ? px.activity.prev_hours ?? px.activity.hours : undefined),
    ratioTile("Задачи прошлой недели", x.tasks_prev, i++, { status: tasksStatus(x.tasks_prev), foot: weekLabel(x.tasks_prev), prev: px.tasks_prev?.done }),
    ratioTile("Задачи этой недели", x.tasks, i++, { foot: weekLabel(x.tasks), prev: px.tasks?.done }),
    ratioTile("Аудиобейджи", x.badges && { done: x.badges.issued, total: x.badges.total }, i++, { foot: "выдано", prev: px.badges?.issued }),
  ];
}

/** Dashboard card body: plan block + six tiles (2 rows × 4 columns). */
export function summaryGrid(s, prev) {
  return html`<div class="summary stagger">${planBlock(s.progress, prev?.progress)}${summaryTiles(s, prev, 1)}</div>`;
}

export const dataDate = (s) => (s?.source_updated_at ? fmtDay(s.source_updated_at) : "");

// ---------- table cells ----------
export function ratioCell(x, status = "") {
  if (!x) return html`<span class="cell-kpi"><span class="v muted">—</span></span>`;
  return html`<span class="cell-kpi"><span class="v">${status ? html`<span class="dot ${status}"></span>` : ""}${x.done} / ${x.total}</span>
    <span class="p">${x.total ? formatValue(Math.round(pct(x.done, x.total)), "percent") : "—"}</span></span>`;
}

export function hoursCell(a) {
  if (!a) return html`<span class="cell-kpi"><span class="v muted">—</span></span>`;
  return html`<span class="cell-kpi"><span class="v">${formatValue(a.prev_hours ?? a.hours, "count")} ч</span>
    <span class="p">сейчас ${formatValue(a.hours, "count")} ч</span></span>`;
}
