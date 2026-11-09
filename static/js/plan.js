// "План продаж на очки" bar, as on the Optimizer home page.
import { formatValue } from "./metrics.js";
import { html } from "./ui.js";

function daysInMonth(period) {
  const m = /^(\d{4})-(\d{2})$/.exec(period || "");
  if (!m) return 30;
  return new Date(+m[1], +m[2], 0).getDate();
}

/** Forecast shortfall/surplus in rubles, computed the same way as the Optimizer site. */
export function forecastDelta(p) {
  if (!p || !(p.plan_amount > 0) || !(p.fact_amount > 0)) return null;
  return (p.forecast_percent / 100 - 1) * p.plan_amount;
}

export function forecastClass(pct) {
  if (pct == null) return "";
  return pct >= 100 ? "fc-excellent" : pct >= 90 ? "fc-good" : "fc-poor";
}

function signedMoney(v) {
  return `${v >= 0 ? "+" : "−"}${formatValue(Math.abs(Math.round(v)), "money")}`;
}

export function planBar(p, period, { compact = false, prev } = {}) {
  if (!p) return "";
  const days = daysInMonth(period);
  const passed = Math.max(0, Math.min(days, Math.round((p.progress_percent / 100) * days)));
  const delta = forecastDelta(p);
  const exec = Math.max(0, Math.min(100, p.execution_percent || 0));
  return html`<div class="plan-bar ${compact ? "compact" : ""}" title="Выполнение: ${formatValue(p.execution_percent, "percent")}, прошло месяца: ${formatValue(p.progress_percent, "percent")}">
    <div class="plan-main">
      <div class="plan-top">
        <span class="plan-title">План продаж на очки выполнен на <b>${Math.round(p.execution_percent)}%</b></span>
        <span class="plan-days">${passed}/${days} дней месяца · ${Math.round(p.progress_percent)}%</span>
      </div>
      <div class="plan-segs">${Array.from({ length: days }, (_, i) => html`<i class="${i < passed ? "past" : ""}" style="--i:${i}"></i>`)}</div>
      <div class="plan-track" style="--w:${exec}%;--m:${Math.min(100, p.progress_percent)}%"><i></i><span class="marker" title="Сегодня"></span></div>
      ${p.plan_amount ? html`<div class="plan-sum">${formatValue(p.fact_amount, "money")} из ${formatValue(p.plan_amount, "money")}</div>` : ""}
    </div>
    <div class="plan-forecast">
      <span class="lbl">Прогноз</span>
      <span class="big" data-count="${p.forecast_percent}" data-kind="percent" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(p.forecast_percent, "percent")}</span>
      ${delta !== null ? html`<span class="delta ${delta >= 0 ? "pos" : "neg"}">${signedMoney(delta)}</span>` : ""}
    </div>
  </div>`;
}

/** Compact cell for tables: execution % with a mini bar, or forecast %. */
export function planCell(p, what) {
  if (!p) return html`<span class="plan-cell"><span class="v" style="color:var(--muted)">—</span></span>`;
  if (what === "forecast") {
    const d = forecastDelta(p);
    return html`<span class="plan-cell"><span class="v ${forecastClass(p.forecast_percent)}">${formatValue(p.forecast_percent, "percent")}</span>
      ${d !== null ? html`<span class="p" style="color:var(--muted);font-size:11.5px">${signedMoney(d)}</span>` : ""}</span>`;
  }
  return html`<span class="plan-cell"><span class="v">${formatValue(p.execution_percent, "percent")}</span>
    <span class="mini-track"><i style="--w:${Math.max(0, Math.min(100, p.execution_percent))}%"></i></span></span>`;
}
