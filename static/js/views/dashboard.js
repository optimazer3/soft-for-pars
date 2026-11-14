// Dashboard: every client with the key metrics of the Optimizer home page.
import { api } from "../api.js";
import { formatValue, metricKind, metricLabel, metricStatus } from "../metrics.js";
import {
  animateCounters, avatar, debounce, fmtPeriod, hostOf, html, icon, mount, plural, refreshRelTimes,
  relSpan, segmented, STATUS_TEXT, syncErrorToast, toast, withBusy,
} from "../ui.js";
import { planCell } from "../plan.js";
import { hoursCell, kpiDate, ratioCell, signalsCell, snapshotDate, summaryGrid, tasksStatus } from "../summary.js";
import { editMetrics } from "../metric-editor.js";
import { reportDay, selectReportDay } from "../report-date.js";

/** One KPI tile. `prev` = previous value for the count-up animation. */
export function tile(key, m, i = 0, prev) {
  const kind = metricKind(key);
  if (!m) {
    return html`<div class="tile empty neutral" style="--i:${i}">
      <div class="tile-label">${metricLabel(key)}</div>
      <div class="tile-value">—</div>
      <div class="tile-foot"><span>Нет данных</span></div>
      <div class="meter"><i></i></div></div>`;
  }
  const status = metricStatus(m);
  const exec = m.plan ? Math.max(0, Math.min(100, m.execution || 0)) : 0;
  return html`<div class="tile ${status}" style="--i:${i}">
    <div class="tile-label">${metricLabel(key)}</div>
    <div class="tile-value" data-count="${m.current}" data-kind="${kind}" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(m.current, kind)}</div>
    <div class="tile-foot">
      <span>План ${m.plan ? formatValue(m.plan, kind) : "—"}</span>
      ${m.plan ? html`<span class="tile-exec" title="Выполнение плана"><span class="dot ${status}"></span>${formatValue(m.execution, "percent")}</span>` : ""}
    </div>
    <div class="meter"><i style="--w:${exec}%"></i></div>
  </div>`;
}

/** Status pill is shown only when there is something to say (not for the normal "ok" state). */
function statusPill(c) {
  if (!c.enabled) return html`<span class="pill off">Выключен</span>`;
  if (c.last_status === "ok") return "";
  return html`<span class="pill ${c.last_status}">${c.last_status === "running" ? icon("refresh", "spin") : ""}${STATUS_TEXT[c.last_status] || c.last_status}</span>`;
}

const sep = html`<span class="sep">·</span>`;

const columns = [
  { key: "name", label: "Клиент" },
  { key: "_exec", label: "План продаж", width: 99 },
  { key: "_forecast", label: "Прогноз", width: 99 },
  { key: "sales_amount", label: "Сумма заказов", width: 130 },
  { key: "vtl_orders_count", label: "Заказы ВТЛ", width: 88 },
  { key: "_activity", label: "Активность", width: 97 },
  { key: "_tasks_prev", label: "Задачи · прош.", title: "Задачи прошлой недели", width: 109 },
  { key: "_tasks", label: "Задачи · тек.", title: "Задачи этой недели", width: 93 },
  { key: "_created", label: "Задач за день", title: "Задач поставлено за день", width: 95 },
  { key: "_signals", label: "Сигналы", title: "Сигналы · разобрано / всего", width: 85 },
  { key: "_analysis", label: "Задачи из анализа", title: "Задачи из анализа филиалов", width: 127 },
  { key: "_badges", label: "Бейджи", width: 67 },
  { key: "_date", label: "Дата снимка", width: 96 },
];

function panel(c, i, prevSnap, canSync = true) {
  const s = c.snapshot;
  const running = c.last_status === "running";
  return html`<section class="panel" data-id="${c.id}" style="--i:${i}">
    <div class="panel-head">
      ${avatar(c.name)}
      <div class="panel-title">
        <h3><a href="#/client/${c.id}">${c.name}</a>${statusPill(c)}</h3>
        <div class="panel-meta">
          <a href="${c.base_url}" target="_blank" rel="noopener">${hostOf(c.base_url)}</a>
          ${s ? html`${sep}<span>${plural(s.branches_count, "салон", "салона", "салонов")}</span>` : ""}
          ${snapshotDate(s) ? html`${sep}<span>снимок от ${snapshotDate(s)}</span>` : ""}
          ${s?.fetched_at ? html`${sep}<span>обновлено ${relSpan(s.fetched_at)}</span>` : ""}
        </div>
      </div>
      <div class="panel-actions">
        ${canSync ? html`<button class="icon-btn" data-act="sync" title="Обновить сейчас" aria-label="Обновить сейчас" ${running ? "disabled" : ""}>${icon("refresh", running ? "spin" : "")}</button>` : ""}
        <button class="icon-btn" data-act="metrics" title="Изменить показатели" aria-label="Изменить показатели">${icon("edit")}</button>
        <a class="btn btn-sm" href="#/client/${c.id}">Подробнее ${icon("arrowRight")}</a>
      </div>
    </div>
    ${c.last_status === "error" && c.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Не удалось обновить данные.</b> ${c.last_error}</div></div>` : ""}
    ${s
      ? summaryGrid(s, prevSnap)
      : html`<div class="empty inline">
          <p>${canSync ? "Данных пока нет" : "За эту дату данных нет"}</p>
          ${running || !canSync ? "" : html`<button class="btn btn-primary btn-sm" data-act="sync">${icon("refresh")} Обновить сейчас</button>`}</div>`}
  </section>`;
}

function cellKpi(key, m) {
  if (!m) return html`<span class="cell-kpi"><span class="v" style="color:var(--text-3)">—</span></span>`;
  const kind = metricKind(key);
  const fact = formatValue(m.current, kind);
  const plan = m.plan ? `план ${formatValue(m.plan, kind)}` : "план —";
  return html`<span class="cell-kpi">
    <span class="v" title="${fact}"><span class="dot ${metricStatus(m)}"></span><span>${fact}</span></span>
    <span class="p" title="${plan}">${plan}</span></span>`;
}

function skeleton() {
  return html`<div class="page-head"><div><div class="skeleton" style="width:180px;height:32px"></div></div></div>
    <div class="panels">${[0, 1].map(() => html`<div class="panel">
      <div class="skeleton" style="width:240px;height:38px;margin-bottom:18px"></div>
      <div class="skeleton" style="height:62px;margin-bottom:16px"></div>
      <div class="summary">${Array.from({ length: 7 }, (_, i) => html`<div class="skeleton" style="height:118px;${i === 0 ? "grid-column:span 2" : ""}"></div>`)}</div></div>`)}</div>`;
}

export async function render(root) {
  mount(root, skeleton());
  let day = reportDay();
  let data = await api.dashboard(day);
  let mode = "table";
  let query = "";
  let sort = { key: "name", dir: 1 };

  const sortValue = (c) => {
    if (sort.key === "name") return c.name.toLowerCase();
    if (sort.key === "_exec") return c.snapshot?.progress?.execution_percent ?? null;
    if (sort.key === "_forecast") return c.snapshot?.progress?.forecast_percent ?? null;
    const x = c.snapshot?.extras || {};
    const ratio = (t) => (t?.done != null && t.total ? t.done / t.total : null);
    if (sort.key === "_activity") return x.activity ? x.activity.prev_hours ?? x.activity.hours : null;
    if (sort.key === "_tasks_prev") return ratio(x.tasks_prev);
    if (sort.key === "_tasks") return ratio(x.tasks);
    if (sort.key === "_badges") return x.badges ? ratio({ done: x.badges.issued, total: x.badges.total }) : null;
    if (sort.key === "_created") return x.tasks_created ?? null;
    if (sort.key === "_signals") return x.signals?.done ?? null;
    if (sort.key === "_analysis") return x.analysis_tasks ?? null;
    if (sort.key === "_date") return c.snapshot?.fetched_at ? c.snapshot.day : null;
    return c.snapshot?.kpi[sort.key]?.current ?? null;
  };

  const visible = () => {
    const q = query.trim().toLowerCase();
    const list = data.clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.base_url.toLowerCase().includes(q));
    if (mode !== "table") return list;
    return [...list].sort((a, b) => {
      const x = sortValue(a), y = sortValue(b);
      if (x === null || y === null) return (x === null) - (y === null); // clients without data go last
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    });
  };

  function summaryHtml() {
    const total = data.clients.length;
    const err = data.clients.filter((c) => c.enabled && c.last_status === "error").length;
    const periods = [...new Set(data.clients.map((c) => c.snapshot?.period).filter(Boolean))];
    return html`<span>${plural(total, "клиент", "клиента", "клиентов")}</span>
      ${periods.length === 1 ? html`${sep}<span>${fmtPeriod(periods[0])}</span>` : ""}
      ${err ? html`<span class="pill error">${plural(err, "ошибка", "ошибки", "ошибок")}</span>` : ""}`;
  }

  function bodyHtml(prev = {}) {
    const list = visible();
    if (!data.clients.length) {
      return html`<div class="empty">
        <div class="big-ico">${icon("users")}</div>
        <h3>Пока нет ни одного клиента</h3>
        <p>Добавьте сайт Оптимайзера клиента — и его показатели появятся здесь.</p>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a></div>`;
    }
    if (!list.length) return html`<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте изменить запрос</p></div>`;
    if (mode === "cards") {
      return html`<div class="panels stagger">${list.map((c, i) => panel(c, i, prev[c.id], !day || day === data.today))}</div>`;
    }
    const th = ({ key, label, title = label }) => {
      const active = sort.key === key;
      const descending = sort.dir < 0;
      return html`<th scope="col" class="sortable ${active ? `sorted ${descending ? "desc" : ""}` : ""}" data-sort="${key}"
        ${active ? html`aria-sort="${descending ? "descending" : "ascending"}"` : ""}>
        <button type="button" class="column-label" title="${title}" aria-label="${title}">${label}<span class="arrow" aria-hidden="true">▲</span></button>
      </th>`;
    };
    return html`<div class="table-wrap" role="region" aria-label="Таблица показателей" tabindex="0"><table class="grid kpi-table">
      <colgroup><col>${columns.slice(1).map(({ width }) => html`<col style="width:${width}px">`)}<col style="width:42px"></colgroup>
      <thead><tr>${columns.map(th)}<th scope="col" aria-label="Действия"></th></tr></thead>
      <tbody>${list.map((c, i) => html`<tr style="--i:${i}" data-id="${c.id}">
        <td><div class="project-cell"><a class="client-cell" href="#/client/${c.id}">${avatar(c.name)}<span>
          <div class="name" title="${c.name}">${c.name}</div>
          <div class="sub"><span class="dot ${c.enabled ? c.last_status : "never"}"></span>
            ${c.snapshot?.fetched_at ? relSpan(c.snapshot.fetched_at, true)
              : c.snapshot ? html`<span title="Есть показатели">Есть данные</span>`
              : html`<span title="${day ? "Нет данных за дату" : "Нет данных"}">Нет данных</span>`}
          </div></span></a>
          <button class="icon-btn" data-act="metrics" title="Изменить показатели" aria-label="Изменить показатели">${icon("edit")}</button>
        </div></td>
        <td class="num">${planCell(c.snapshot?.progress, "exec")}</td>
        <td class="num">${planCell(c.snapshot?.progress, "forecast")}</td>
        ${["sales_amount", "vtl_orders_count"].map((k) => html`<td class="num">${cellKpi(k, c.snapshot?.kpi[k])}</td>`)}
        <td class="num">${hoursCell(c.snapshot?.extras?.activity)}</td>
        <td class="num">${ratioCell(c.snapshot?.extras?.tasks_prev, tasksStatus(c.snapshot?.extras?.tasks_prev))}</td>
        <td class="num">${ratioCell(c.snapshot?.extras?.tasks)}</td>
        <td class="num">${formatValue(c.snapshot?.extras?.tasks_created, "count")}</td>
        <td class="num">${signalsCell(c.snapshot?.extras?.signals)}</td>
        <td class="num">${formatValue(c.snapshot?.extras?.analysis_tasks, "count")}</td>
        <td class="num">${ratioCell(c.snapshot?.extras?.badges && { done: c.snapshot.extras.badges.issued, total: c.snapshot.extras.badges.total })}</td>
        <td class="num cell-muted" title="${kpiDate(c.snapshot) ? `KPI в Оптимайзере на ${kpiDate(c.snapshot)}` : ""}">${snapshotDate(c.snapshot) || "—"}</td>
        <td><div class="row-actions">
          ${!day || day === data.today ? html`<button class="icon-btn" data-act="sync" title="Обновить сейчас" aria-label="Обновить сейчас" ${c.last_status === "running" ? "disabled" : ""}>${icon("refresh", c.last_status === "running" ? "spin" : "")}</button>` : ""}
        </div></td>
      </tr>`)}</tbody></table></div>`;
  }

  mount(root, html`
    <div class="page-head">
      <div>
        <h1 class="page-title">Показатели</h1>
        <div class="page-sub" id="summary">${summaryHtml()}</div>
        <div class="page-sub" id="signal-status" role="status" hidden></div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search")}<input id="q" placeholder="Поиск клиента" aria-label="Поиск клиента"></label>
        <div class="date-filter">
          <label for="report-day">Дата</label>
          <input type="date" id="report-day" value="${day}" max="${data.today}">
          <button type="button" class="btn btn-sm" id="latest-data" ${day ? "" : "disabled"}>Последние данные</button>
        </div>
        <div class="segmented" id="mode">
          <button data-value="table" class="${mode === "table" ? "active" : ""}">${icon("table")} Таблица</button>
          <button data-value="cards" class="${mode === "cards" ? "active" : ""}">${icon("grid")} Карточки</button>
        </div>
      </div>
    </div>
    <div id="dash-body">${bodyHtml()}</div>`);
  const bodyEl = root.querySelector("#dash-body");
  const summaryEl = root.querySelector("#summary");
  const input = root.querySelector("#q");
  const dateInput = root.querySelector("#report-day");
  const latest = root.querySelector("#latest-data");
  const signalStatus = root.querySelector("#signal-status");
  const drawBody = (prev) => {
    const scrollLeft = bodyEl.querySelector(".table-wrap")?.scrollLeft || 0;
    mount(bodyEl, bodyHtml(prev));
    if (scrollLeft) {
      const table = bodyEl.querySelector(".table-wrap");
      if (table) table.scrollLeft = scrollLeft;
    }
  };

  input.addEventListener("input", debounce(() => { query = input.value; drawBody(); }, 120));
  segmented(root.querySelector("#mode"), (v) => {
    mode = v;
    drawBody();
  });
  dateInput.addEventListener("change", () => {
    if (dateInput.reportValidity()) changeDay(dateInput.value);
  });
  latest.addEventListener("click", () => changeDay(""));

  // ---- actions ----
  bodyEl.addEventListener("click", async (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      const focused = th.contains(document.activeElement);
      sort = { key, dir: sort.key === key ? -sort.dir : key === "name" ? 1 : -1 };
      drawBody();
      if (focused) bodyEl.querySelector(`th[data-sort="${key}"] button`).focus({ preventScroll: true });
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const id = +btn.closest("[data-id]").dataset.id;
    const client = data.clients.find((c) => c.id === id);
    if (btn.dataset.act === "metrics") {
      const result = await editMetrics(client, client.snapshot, day || data.today);
      if (result?.changed) await refresh(true);
      return;
    }
    await withBusy(btn, async () => {
      try {
        const res = await api.syncClient(id);
        res.ok
          ? toast("success", "Данные обновлены", client?.name)
          : toast("error", `${client?.name}: не удалось обновить`, res.error);
      } catch (err) {
        syncErrorToast(err);
      }
    });
    await refresh();
  });

  // ---- live refresh: during a global sync, after actions, when the tab becomes visible ----
  let requestId = 0;
  let signalRequestId = 0;
  let loadingDay = false;
  let refreshing = false;
  async function changeDay(newDay) {
    if (newDay === day && !loadingDay) return;
    const id = ++requestId;
    signalRequestId++;
    signalStatus.hidden = true;
    loadingDay = true;
    bodyEl.inert = true;
    try {
      const fresh = await api.dashboard(newDay);
      if (id !== requestId || !root.isConnected) return;
      day = newDay;
      selectReportDay(day);
      data = fresh;
      mount(summaryEl, summaryHtml());
      drawBody();
    } catch (err) {
      if (id === requestId && root.isConnected) toast("error", "Не удалось загрузить данные за дату", err.message);
    } finally {
      if (id === requestId) {
        loadingDay = false;
        bodyEl.inert = false;
        dateInput.value = day;
        latest.disabled = !day;
        loadMissingSignals();
      }
    }
  }
  async function loadMissingSignals() {
    const requestedDay = day;
    const pending = data.clients.filter((client) => client.signals_complete === false);
    if (!requestedDay || !pending.length) return;
    const id = ++signalRequestId;
    signalStatus.hidden = false;
    signalStatus.textContent = "Загружаем сигналы за выбранную дату…";
    let failed = 0;
    let available = false;
    for (const client of pending) {
      if (id !== signalRequestId || !bodyEl.isConnected) return;
      try {
        const response = await api.loadSignals(client.id, requestedDay);
        available ||= response.available;
      } catch {
        failed++;
      }
    }
    if (id !== signalRequestId || !bodyEl.isConnected) return;
    if (available) await refresh(true);
    if (id !== signalRequestId || !bodyEl.isConnected) return;
    signalStatus.hidden = !failed;
    if (failed) signalStatus.textContent = failed === pending.length
      ? "Не удалось загрузить сигналы за выбранную дату"
      : "Для части проектов не удалось загрузить сигналы";
  }
  loadMissingSignals();
  async function refresh(force = false) {
    if (loadingDay || (refreshing && !force)) return;
    const id = ++requestId;
    refreshing = true;
    try {
      const old = data;
      const fresh = await api.dashboard(day);
      if (id !== requestId || !root.isConnected) return;
      data = fresh;
      dateInput.max = data.today;
      mount(summaryEl, summaryHtml());
      refreshRelTimes(bodyEl);
      const prevSnap = Object.fromEntries(old.clients.map((c) => [c.id, c.snapshot]));
      const sameSet = old.clients.length === data.clients.length
        && data.clients.every((c, i) => old.clients[i].id === c.id);
      const changed = data.clients.filter((c) => {
        const o = old.clients.find((x) => x.id === c.id);
        return !o || o.last_sync_at !== c.last_sync_at || o.last_status !== c.last_status
          || o.enabled !== c.enabled || o.name !== c.name
          || JSON.stringify(o.snapshot) !== JSON.stringify(c.snapshot);
      });
      if (force) { drawBody(); return; }
      if (!changed.length && sameSet) return;
      if (mode !== "cards" || !sameSet) { drawBody(prevSnap); return; }
      for (const c of changed) {
        const el = bodyEl.querySelector(`.panel[data-id="${c.id}"]`);
        if (!el) continue; // filtered out by the search
        const tmp = document.createElement("div");
        tmp.innerHTML = String(panel(c, 0, prevSnap[c.id], !day || day === data.today));
        const next = tmp.firstElementChild;
        if (prevSnap[c.id]?.fetched_at !== c.snapshot?.fetched_at) next.classList.add("flash");
        next.querySelector(".summary")?.classList.remove("stagger");
        el.replaceWith(next);
        animateCounters(next);
      }
    } catch (err) {
      if (force && root.isConnected) toast("error", "Не удалось обновить таблицу", err.message);
    } finally {
      refreshing = false;
    }
  }
  const onSync = () => refresh();
  const onVisible = () => { if (!document.hidden) refresh(); };
  window.addEventListener("sync:progress", onSync);
  window.addEventListener("sync:done", onSync);
  document.addEventListener("visibilitychange", onVisible);
  const timer = setInterval(onVisible, 60000); // keeps "обновлено N мин назад" honest
  return () => {
    requestId++;
    signalRequestId++;
    window.removeEventListener("sync:progress", onSync);
    window.removeEventListener("sync:done", onSync);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
  };
}

