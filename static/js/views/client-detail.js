// One client: the summary figures and the same sales figures per branch.
import { api } from "../api.js";
import { formatValue, metricKind, metricStatus } from "../metrics.js";
import {
  avatar, fmtDay, fmtPeriod, hostOf, html, icon, mount, refreshRelTimes, relSpan, syncErrorToast, toast, withBusy,
} from "../ui.js";
import { planBar, planCell } from "../plan.js";
import { kpiDate, signalsCell, snapshotDate, summaryTiles } from "../summary.js";
import { editMetrics } from "../metric-editor.js";
import { reportDay } from "../report-date.js";

function kpiCell(key, m) {
  if (!m) return html`<td class="num"><span class="cell-kpi"><span class="v muted">—</span></span></td>`;
  const kind = metricKind(key);
  return html`<td class="num"><span class="cell-kpi"><span class="v"><span class="dot ${metricStatus(m)}"></span>${formatValue(m.current, kind)}</span>
    <span class="p">план ${m.plan ? formatValue(m.plan, kind) : "—"}</span></span></td>`;
}

export async function render(root, [idParam]) {
  const id = +idParam;
  const day = reportDay();
  let { client, snapshot, today, signals_complete: signalsComplete } = await api.snapshot(id, day);
  let disposed = false;
  let signalStatus = day && signalsComplete === false ? "Загружаем сигналы за выбранную дату…" : "";

  function branchesHtml(s) {
    if (!s.branches?.length) return "";
    const rows = [...s.branches.map((b) => ({ ...b, all: false })), { name: "Все салоны", kpi: s.kpi, progress: s.progress, all: true }];
    return html`<div class="section"><h2 class="section-title">По салонам</h2>
      <div class="table-wrap"><table class="grid branches">
        <thead><tr><th>Салон</th><th class="num">План продаж</th><th class="num">Прогноз</th><th class="num">Сумма заказов</th><th class="num">Заказы ВТЛ</th><th class="num">Сигналы · разобрано / всего</th></tr></thead>
        <tbody>${rows.map((b, i) => html`<tr style="--i:${i}" class="${b.all ? "total" : ""}">
          <td>${b.all ? b.name : html`<span class="branch-name">${icon("store")} ${b.name}</span>`}</td>
          ${b.kpi
            ? html`<td class="num">${planCell(b.progress, "exec")}</td><td class="num">${planCell(b.progress, "forecast")}</td>
              ${kpiCell("sales_amount", b.kpi.sales_amount)}${kpiCell("vtl_orders_count", b.kpi.vtl_orders_count)}`
            : html`<td colspan="4" class="cell-muted">${b.error ? "Данные по салону получить не удалось" : "Нет снимка KPI"}</td>`}
          <td class="num">${b.all ? signalsCell(s.extras?.signals) : signalsCell(b.signals)}</td>
        </tr>`)}</tbody>
      </table></div></div>`;
  }

  function draw() {
    const s = snapshot;
    mount(root, html`
      <a class="back" href="#/dashboard">${icon("arrowLeft")} Все клиенты</a>
      <div class="detail-head">
        ${avatar(client.name)}
        <div style="flex:1;min-width:0">
          <h1 class="page-title">${client.name}</h1>
          <div class="page-sub">
            <a class="chip" href="${client.base_url}" target="_blank" rel="noopener">${hostOf(client.base_url)} ${icon("external")}</a>
            ${day ? html`<span class="chip">${icon("calendar")} ${fmtDay(day)}</span>` : ""}
            ${s?.period ? html`<span class="chip">${fmtPeriod(s.period)}</span>` : ""}
            ${snapshotDate(s) && !day ? html`<span class="chip">Снимок от <b>${snapshotDate(s)}</b></span>` : ""}
            ${kpiDate(s) && kpiDate(s) !== snapshotDate(s) ? html`<span class="chip">KPI в Оптимайзере на <b>${kpiDate(s)}</b></span>` : ""}
            ${s?.fetched_at ? html`<span class="chip">${icon("clock")} Обновлено ${relSpan(s.fetched_at)}</span>` : ""}
          </div>
        </div>
        <div class="toolbar">
          <a class="btn" href="#/clients/${client.id}/edit">Настройки клиента</a>
          <button class="btn" type="button" id="edit-metrics">${icon("edit")} Показатели</button>
          ${!day || day === today ? html`<button class="btn btn-primary" id="sync">${icon("refresh")} Обновить</button>` : ""}
        </div>
      </div>
      ${signalStatus ? html`<p class="signal-status" role="status">${signalStatus}</p>` : ""}
      ${client.last_status === "error" && client.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Последнее обновление не удалось.</b> ${client.last_error}</div></div>` : ""}
      ${s ? html`
        ${planBar(s.progress, s.period)}
        <div class="tiles detail-tiles stagger">${summaryTiles(s)}</div>
        ${branchesHtml(s)}`
      : html`<div class="empty"><div class="big-ico">${icon("calendar")}</div><h3>${day ? "За эту дату данных нет" : "Данных пока нет"}</h3></div>`}
    `);

    root.querySelector("#edit-metrics").addEventListener("click", async () => {
      const saved = await editMetrics(client, snapshot, day || today);
      if (saved?.changed) await reload().catch((err) => toast("error", "Не удалось обновить показатели", err.message));
    });
    root.querySelector("#sync")?.addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
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
    const fresh = await api.snapshot(id, day);
    if (disposed || !root.isConnected) return;
    ({ client, snapshot, today } = fresh);
    draw();
  }
  draw();
  if (signalStatus) {
    api.loadSignals(id, day).then(({ available }) => {
      if (disposed) return;
      signalStatus = "";
      if (available) return reload();
      draw();
    }).catch(() => {
      if (disposed) return;
      signalStatus = "Не удалось загрузить сигналы за выбранную дату";
      draw();
    });
  }

  const onDone = () => reload().catch(() => {});
  const timer = setInterval(() => refreshRelTimes(root), 60000);
  window.addEventListener("sync:done", onDone);
  return () => {
    disposed = true;
    window.removeEventListener("sync:done", onDone);
    clearInterval(timer);
  };
}

