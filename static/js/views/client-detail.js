// One client: the summary figures and the same sales figures per branch.
import { api } from "../api.js";
import { formatValue, metricKind, metricStatus } from "../metrics.js";
import {
  avatar, fmtPeriod, hostOf, html, icon, mount, refreshRelTimes, relSpan, syncErrorToast, toast, withBusy,
} from "../ui.js";
import { planBar, planCell } from "../plan.js";
import { dataDate, summaryTiles } from "../summary.js";

function kpiCell(key, m) {
  if (!m) return html`<td class="num"><span class="cell-kpi"><span class="v muted">—</span></span></td>`;
  const kind = metricKind(key);
  return html`<td class="num"><span class="cell-kpi"><span class="v"><span class="dot ${metricStatus(m)}"></span>${formatValue(m.current, kind)}</span>
    <span class="p">план ${m.plan ? formatValue(m.plan, kind) : "—"}</span></span></td>`;
}

export async function render(root, [idParam]) {
  const id = +idParam;
  let { client, snapshot } = await api.snapshot(id);

  function branchesHtml(s) {
    if (!s.branches?.length) return "";
    const rows = [...s.branches.map((b) => ({ ...b, all: false })), { name: "Все салоны", kpi: s.kpi, progress: s.progress, all: true }];
    return html`<div class="section"><h2 class="section-title">По салонам</h2>
      <div class="table-wrap"><table class="grid branches">
        <thead><tr><th>Салон</th><th class="num">План продаж</th><th class="num">Прогноз</th><th class="num">Сумма заказов</th><th class="num">Заказы ВТЛ</th></tr></thead>
        <tbody>${rows.map((b, i) => html`<tr style="--i:${i}" class="${b.all ? "total" : ""}">
          <td>${b.all ? b.name : html`<span class="branch-name">${icon("store")} ${b.name}</span>`}</td>
          ${b.kpi
            ? html`<td class="num">${planCell(b.progress, "exec")}</td><td class="num">${planCell(b.progress, "forecast")}</td>
              ${kpiCell("sales_amount", b.kpi.sales_amount)}${kpiCell("vtl_orders_count", b.kpi.vtl_orders_count)}`
            : html`<td colspan="4" class="cell-error">Данные по салону получить не удалось</td>`}
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
            ${s ? html`<span class="chip">${icon("calendar")} ${fmtPeriod(s.period)}</span>` : ""}
            ${dataDate(s) ? html`<span class="chip">Данные на <b>${dataDate(s)}</b></span>` : ""}
            ${s ? html`<span class="chip">${icon("clock")} Обновлено ${relSpan(s.fetched_at)}</span>` : ""}
          </div>
        </div>
        <div class="toolbar">
          <a class="btn" href="#/clients/${client.id}/edit">${icon("edit")} Изменить</a>
          <button class="btn btn-primary" id="sync">${icon("refresh")} Обновить</button>
        </div>
      </div>
      ${client.last_status === "error" && client.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Последнее обновление не удалось.</b> ${client.last_error}</div></div>` : ""}
      ${s ? html`
        ${planBar(s.progress, s.period)}
        <div class="tiles detail-tiles stagger">${summaryTiles(s)}</div>
        ${branchesHtml(s)}`
      : html`<div class="empty"><div class="big-ico">${icon("refresh")}</div><h3>Данных пока нет</h3>
          <p>Нажмите «Обновить», чтобы получить показатели с сайта клиента.</p></div>`}
    `);

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
