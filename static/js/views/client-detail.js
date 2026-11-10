// One client: all metrics by group, switchable between "all branches" and each branch.
import { api } from "../api.js";
import { GROUPS, METRICS, formatValue, metricKind, metricLabel, metricStatus } from "../metrics.js";
import {
  avatar, fmtDay, fmtPeriod, hostOf, html, icon, mount, refreshRelTimes, relSpan, segmented,
  syncErrorToast, toast, withBusy,
} from "../ui.js";
import { tile } from "./dashboard.js";
import { planBar, planCell } from "../plan.js";

export async function render(root, [idParam]) {
  const id = +idParam;
  let { client, snapshot, key_metrics: keys } = await api.snapshot(id);
  let scope = "all";

  function groupsFor(kpi) {
    const known = new Set(Object.keys(METRICS));
    const extra = Object.keys(kpi).filter((k) => !known.has(k) && kpi[k] && typeof kpi[k] === "object");
    const groups = GROUPS.map(([t, ks]) => [t, ks.filter((k) => k in kpi)]).filter(([, ks]) => ks.length);
    if (extra.length) groups.push(["Другое", extra]);
    return groups;
  }

  const branch = () => (scope === "all" ? null : snapshot?.branches.find((b) => b.id === scope));
  const scopeKpi = () => (!snapshot ? {} : scope === "all" ? snapshot.kpi : branch()?.kpi || {});
  const scopeProgress = () => (!snapshot ? null : scope === "all" ? snapshot.progress : branch()?.progress || null);

  function metricsHtml(prev, prevProgress) {
    const b = branch();
    if (b && !b.kpi) {
      return html`<div class="error-banner">${icon("alert")}<div><b>По этому салону данные получить не удалось.</b> ${b.error || ""}</div></div>`;
    }
    const kpi = scopeKpi();
    const sections = groupsFor(kpi).map(([title, ks]) => html`<div class="section">
      <h2 class="section-title">${title}</h2>
      <div class="tiles auto stagger">${ks.map((k, i) => tile(k, kpi[k], i, prev?.[k]?.current))}</div></div>`);
    return html`${planBar(scopeProgress(), snapshot.period, { prev: prevProgress?.forecast_percent })}${sections}`;
  }

  function compareHtml() {
    const br = snapshot.branches.filter((b) => b.kpi);
    if (br.length < 2) return "";
    const cell = (k, m) => {
      if (!m) return html`<td class="num">—</td>`;
      return html`<td class="num"><span class="cell-kpi"><span class="v"><span class="dot ${metricStatus(m)}"></span>${formatValue(m.current, metricKind(k))}</span>
        <span class="p">план ${m.plan ? formatValue(m.plan, metricKind(k)) : "—"}</span></span></td>`;
    };
    return html`<div class="section"><h2 class="section-title">Сравнение салонов</h2>
      <div class="table-wrap"><table class="grid compare">
        <thead><tr><th>Показатель</th>${br.map((b) => html`<th class="num">${b.name}</th>`)}<th class="num">Все салоны</th></tr></thead>
        <tbody>
          <tr><td>План продаж на очки</td>${br.map((b) => html`<td class="num">${planCell(b.progress, "exec")}</td>`)}<td class="num">${planCell(snapshot.progress, "exec")}</td></tr>
          <tr><td>Прогноз выполнения</td>${br.map((b) => html`<td class="num">${planCell(b.progress, "forecast")}</td>`)}<td class="num">${planCell(snapshot.progress, "forecast")}</td></tr>
          ${keys.map((k, i) => html`<tr style="--i:${i}"><td>${metricLabel(k)}</td>
          ${br.map((b) => cell(k, b.kpi[k]))}${cell(k, snapshot.kpi[k])}</tr>`)}</tbody>
      </table></div></div>`;
  }

  function draw() {
    const s = snapshot;
    if (s && scope !== "all" && !s.branches.some((b) => b.id === scope)) scope = "all";
    mount(root, html`
      <a class="back" href="#/dashboard">${icon("arrowLeft")} Все клиенты</a>
      <div class="detail-head">
        ${avatar(client.name)}
        <div style="flex:1;min-width:0">
          <h1 class="page-title">${client.name}</h1>
          <div class="page-sub">
            <a class="chip" href="${client.base_url}" target="_blank" rel="noopener">${hostOf(client.base_url)} ${icon("external")}</a>
            ${s ? html`<span class="chip">${icon("calendar")} ${fmtPeriod(s.period)}</span>` : ""}
            ${s ? html`<span class="chip">${icon("clock")} Обновлено ${relSpan(s.fetched_at)}</span>` : ""}
            ${s?.source_updated_at ? html`<span class="chip">Данные актуальны на <b>${fmtDay(s.source_updated_at)}</b></span>` : ""}
          </div>
        </div>
        <div class="toolbar">
          <a class="btn" href="#/clients/${client.id}/edit">${icon("edit")} Изменить</a>
          <button class="btn btn-primary" id="sync">${icon("refresh")} Обновить</button>
        </div>
      </div>
      ${client.last_status === "error" && client.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Последнее обновление не удалось.</b> ${client.last_error}</div></div>` : ""}
      ${s ? html`
        ${s.branches.length > 1 ? html`<div class="branch-tabs"><div class="segmented" id="scope">
          <button data-value="all" class="${scope === "all" ? "active" : ""}">Все салоны</button>
          ${s.branches.map((b) => html`<button data-value="${b.id}" class="${scope === b.id ? "active" : ""}">${icon("store")} ${b.name}</button>`)}
        </div></div>` : ""}
        <div id="metrics">${metricsHtml()}</div>
        ${compareHtml()}`
      : html`<div class="empty"><div class="big-ico">${icon("refresh")}</div><h3>Данных пока нет</h3>
          <p>Нажмите «Обновить», чтобы получить показатели с сайта клиента.</p></div>`}
    `);

    const scopeEl = root.querySelector("#scope");
    if (scopeEl) {
      segmented(scopeEl, (v) => {
        const prev = scopeKpi();
        const prevProgress = scopeProgress();
        scope = v;
        mount(root.querySelector("#metrics"), metricsHtml(prev, prevProgress));
      });
    }

    root.querySelector("#sync").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
      try {
        const res = await api.syncClient(id);
        res.ok ? toast("success", "Данные обновлены") : toast("error", "Не удалось обновить", res.error);
        await reload();
      } catch (err) {
        syncErrorToast(err);
      }
    }));
  }

  async function reload() {
    const fresh = await api.snapshot(id);
    if (!root.isConnected) return;
    ({ client, snapshot } = fresh);
    draw();
  }
  draw();

  const onDone = () => reload().catch(() => {});
  const timer = setInterval(() => refreshRelTimes(root), 60000);
  window.addEventListener("sync:done", onDone);
  return () => {
    window.removeEventListener("sync:done", onDone);
    clearInterval(timer);
  };
}
