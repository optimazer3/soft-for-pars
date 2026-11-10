// "План продаж на очки": hero banner (client page), compact row (dashboard), table cells.
import { formatValue } from "./metrics.js";
import { html } from "./ui.js";

function daysInMonth(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) return 30;
  return new Date(+m[1], +m[2], 0).getDate();
}

const clamp = (v) => Math.max(0, Math.min(100, Number(v) || 0));

/** Forecast shortfall/surplus in rubles, computed the same way as the Optimizer site. */
export function forecastDelta(p) {
  if (!p || !(p.plan_amount > 0) || !(p.fact_amount > 0)) return null;
  return (p.forecast_percent / 100 - 1) * p.plan_amount;
}

/** Status of the forecast: reaching the plan is good, a small gap is a warning. */
export function forecastStatus(pct) {
  if (pct == null) return "neutral";
  return pct >= 100 ? "excellent" : pct >= 90 ? "good" : "poor";
}

function signedMoney(v) {
  return `${v >= 0 ? "+" : "−"}${formatValue(Math.abs(Math.round(v)), "money")}`;
}

const deltaChip = (delta) => (delta === null ? "" : html`<span class="delta ${delta >= 0 ? "pos" : "neg"}">${signedMoney(delta)}</span>`);

/** Hero banner: one per page. */
export function planBar(p, period, { prev } = {}) {
  if (!p) return "";
  const days = daysInMonth(period);
  const passed = Math.max(0, Math.min(days, Math.round((p.progress_percent / 100) * days)));
  return html`<div class="plan-bar">
    <div class="plan-main">
      <div class="plan-top">
        <span class="plan-title">План продаж на очки выполнен на <b>${Math.round(p.execution_percent)}%</b></span>
        <span class="plan-days">${passed} из ${days} дней месяца · ${Math.round(p.progress_percent)}%</span>
      </div>
      <div class="plan-segs" aria-hidden="true">${Array.from({ length: days }, (_, i) => html`<i class="${i < passed ? "past" : ""}"></i>`)}</div>
      <div class="plan-track" style="--w:${clamp(p.execution_percent)}%;--m:${clamp(p.progress_percent)}%"><i></i><span class="marker" title="Сегодня"></span></div>
      ${p.plan_amount ? html`<div class="plan-sum">${formatValue(p.fact_amount, "money")} из ${formatValue(p.plan_amount, "money")}</div>` : ""}
    </div>
    <div class="plan-forecast">
      <span class="lbl">Прогноз</span>
      <span class="big" data-count="${p.forecast_percent}" data-kind="percent" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(p.forecast_percent, "percent")}</span>
      ${deltaChip(forecastDelta(p))}
    </div>
  </div>`;
}

/** Compact row for a client card on the dashboard. */
export function planRow(p, { prev } = {}) {
  if (!p) return "";
  return html`<div class="plan-row" title="Вертикальная отметка — сколько месяца уже прошло">
    <div class="plan-row-head">
      <span class="lead">План продаж на очки</span>
      <span class="pct">${formatValue(p.execution_percent, "percent")}</span>
      ${p.plan_amount ? html`<span class="muted">${formatValue(p.fact_amount, "money")} из ${formatValue(p.plan_amount, "money")}</span>` : ""}
      <span class="right">
        <span class="muted">Прогноз</span>
        <b data-count="${p.forecast_percent}" data-kind="percent" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(p.forecast_percent, "percent")}</b>
        ${deltaChip(forecastDelta(p))}
      </span>
    </div>
    <div class="plan-meter" style="--w:${clamp(p.execution_percent)}%;--m:${clamp(p.progress_percent)}%"><i></i><span class="marker"></span></div>
  </div>`;
}

/** Table cell: execution % with a mini bar, or forecast % with its delta. */
export function planCell(p, what) {
  if (!p) return html`<span class="plan-cell"><span class="v" style="color:var(--text-3)">—</span></span>`;
  if (what === "forecast") {
    const d = forecastDelta(p);
    return html`<span class="plan-cell"><span class="v"><span class="dot ${forecastStatus(p.forecast_percent)}"></span>${formatValue(p.forecast_percent, "percent")}</span>
      ${d !== null ? html`<span class="p">${signedMoney(d)}</span>` : ""}</span>`;
  }
  return html`<span class="plan-cell"><span class="v">${formatValue(p.execution_percent, "percent")}</span>
    <span class="mini-track"><i style="--w:${clamp(p.execution_percent)}%"></i></span></span>`;
}
