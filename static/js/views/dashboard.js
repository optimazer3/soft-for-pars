// Dashboard: every client with the key metrics of the Optimizer home page.
import { api } from "../api.js";
import { formatValue, metricKind, metricLabel, metricStatus } from "../metrics.js";
import {
  animateCounters, avatar, debounce, fmtPeriod, hostOf, html, icon, mount, plural, refreshRelTimes,
  relSpan, segmented, STATUS_TEXT, syncErrorToast, toast, withBusy,
} from "../ui.js";
import { planCell, planRow } from "../plan.js";

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

function panel(c, keys, i, prevSnap) {
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
          ${s ? html`${sep}<span>обновлено ${relSpan(s.fetched_at)}</span>` : ""}
        </div>
      </div>
      <div class="panel-actions">
        <button class="icon-btn" data-act="sync" title="Обновить сейчас" aria-label="Обновить сейчас" ${running ? "disabled" : ""}>${icon("refresh", running ? "spin" : "")}</button>
        <a class="icon-btn" href="#/clients/${c.id}/edit" title="Редактировать" aria-label="Редактировать">${icon("edit")}</a>
        <a class="btn btn-sm" href="#/client/${c.id}">Подробнее ${icon("arrowRight")}</a>
      </div>
    </div>
    ${c.last_status === "error" && c.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Не удалось обновить данные.</b> ${c.last_error}</div></div>` : ""}
    ${s
      ? html`${planRow(s.progress, { prev: prevSnap?.progress?.forecast_percent })}
        <div class="tiles stagger">${keys.map((k, j) => tile(k, s.kpi[k], j, prevSnap?.kpi?.[k]?.current))}</div>`
      : html`<div class="empty inline">
          <p>Данных пока нет</p>
          ${running ? "" : html`<button class="btn btn-primary btn-sm" data-act="sync">${icon("refresh")} Обновить сейчас</button>`}</div>`}
  </section>`;
}

function cellKpi(key, m) {
  if (!m) return html`<span class="cell-kpi"><span class="v" style="color:var(--text-3)">—</span></span>`;
  const kind = metricKind(key);
  return html`<span class="cell-kpi">
    <span class="v"><span class="dot ${metricStatus(m)}"></span>${formatValue(m.current, kind)}</span>
    <span class="p">план ${m.plan ? formatValue(m.plan, kind) : "—"}</span></span>`;
}

function skeleton() {
  return html`<div class="page-head"><div><div class="skeleton" style="width:180px;height:32px"></div></div></div>
    <div class="panels">${[0, 1].map(() => html`<div class="panel">
      <div class="skeleton" style="width:240px;height:38px;margin-bottom:18px"></div>
      <div class="skeleton" style="height:62px;margin-bottom:16px"></div>
      <div class="tiles">${Array.from({ length: 10 }, () => html`<div class="skeleton" style="height:118px"></div>`)}</div></div>`)}</div>`;
}

export async function render(root) {
  mount(root, skeleton());
  let data = await api.dashboard();
  let mode = localStorage.getItem("dashMode") === "table" ? "table" : "cards";
  let query = "";
  let sort = { key: "name", dir: 1 };

  const sortValue = (c) => {
    if (sort.key === "name") return c.name.toLowerCase();
    if (sort.key === "_exec") return c.snapshot?.progress?.execution_percent ?? null;
    if (sort.key === "_forecast") return c.snapshot?.progress?.forecast_percent ?? null;
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
      return html`<div class="panels stagger">${list.map((c, i) => panel(c, data.key_metrics, i, prev[c.id]))}</div>`;
    }
    const th = (key, label, num = true) => html`<th class="sortable ${num ? "num" : ""} ${sort.key === key ? `sorted ${sort.dir < 0 ? "desc" : ""}` : ""}" data-sort="${key}">${label}<span class="arrow">▲</span></th>`;
    return html`<div class="table-wrap"><table class="grid kpi-table">
      <thead><tr>${th("name", "Клиент", false)}${th("_exec", "План продаж")}${th("_forecast", "Прогноз")}${data.key_metrics.map((k) => th(k, metricLabel(k)))}<th></th></tr></thead>
      <tbody>${list.map((c, i) => html`<tr style="--i:${i}" data-id="${c.id}">
        <td><a class="client-cell" href="#/client/${c.id}">${avatar(c.name)}<span>
          <div class="name">${c.name}</div>
          <div class="sub"><span class="dot ${c.enabled ? c.last_status : "never"}"></span>${c.snapshot ? relSpan(c.snapshot.fetched_at) : "нет данных"}</div></span></a></td>
        <td class="num">${planCell(c.snapshot?.progress, "exec")}</td>
        <td class="num">${planCell(c.snapshot?.progress, "forecast")}</td>
        ${data.key_metrics.map((k) => html`<td class="num">${cellKpi(k, c.snapshot?.kpi[k])}</td>`)}
        <td><div class="row-actions"><button class="icon-btn" data-act="sync" title="Обновить сейчас" aria-label="Обновить сейчас" ${c.last_status === "running" ? "disabled" : ""}>${icon("refresh", c.last_status === "running" ? "spin" : "")}</button></div></td>
      </tr>`)}</tbody></table></div>`;
  }

  mount(root, html`
    <div class="page-head">
      <div>
        <h1 class="page-title">Дашборд</h1>
        <div class="page-sub" id="summary">${summaryHtml()}</div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search")}<input id="q" placeholder="Поиск клиента" aria-label="Поиск клиента"></label>
        <div class="segmented" id="mode">
          <button data-value="cards" class="${mode === "cards" ? "active" : ""}">${icon("grid")} Карточки</button>
          <button data-value="table" class="${mode === "table" ? "active" : ""}">${icon("table")} Таблица</button>
        </div>
      </div>
    </div>
    <div id="dash-body">${bodyHtml()}</div>`);
  const bodyEl = root.querySelector("#dash-body");
  const summaryEl = root.querySelector("#summary");
  const input = root.querySelector("#q");
  const drawBody = (prev) => mount(bodyEl, bodyHtml(prev));

  input.addEventListener("input", debounce(() => { query = input.value; drawBody(); }, 120));
  segmented(root.querySelector("#mode"), (v) => {
    mode = v;
    localStorage.setItem("dashMode", v);
    drawBody();
  });

  // ---- actions ----
  bodyEl.addEventListener("click", async (e) => {
    const th = e.target.closest("th[data-sort]");
    if (th) {
      const key = th.dataset.sort;
      sort = { key, dir: sort.key === key ? -sort.dir : key === "name" ? 1 : -1 };
      drawBody();
      return;
    }
    const btn = e.target.closest('[data-act="sync"]');
    if (!btn || btn.disabled) return;
    const id = +btn.closest("[data-id]").dataset.id;
    const client = data.clients.find((c) => c.id === id);
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
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const old = data;
      let fresh;
      try { fresh = await api.dashboard(); } catch { return; }
      if (!root.isConnected) return;
      data = fresh;
      mount(summaryEl, summaryHtml());
      refreshRelTimes(bodyEl);
      const prevSnap = Object.fromEntries(old.clients.map((c) => [c.id, c.snapshot]));
      const sameSet = old.clients.length === data.clients.length
        && data.clients.every((c, i) => old.clients[i].id === c.id);
      const changed = data.clients.filter((c) => {
        const o = old.clients.find((x) => x.id === c.id);
        return !o || o.last_sync_at !== c.last_sync_at || o.last_status !== c.last_status
          || o.enabled !== c.enabled || o.name !== c.name;
      });
      if (!changed.length && sameSet) return;
      if (mode !== "cards" || !sameSet) { drawBody(prevSnap); return; }
      for (const c of changed) {
        const el = bodyEl.querySelector(`.panel[data-id="${c.id}"]`);
        if (!el) continue; // filtered out by the search
        const tmp = document.createElement("div");
        tmp.innerHTML = String(panel(c, data.key_metrics, 0, prevSnap[c.id]));
        const next = tmp.firstElementChild;
        if (prevSnap[c.id]?.fetched_at !== c.snapshot?.fetched_at) next.classList.add("flash");
        next.querySelector(".tiles")?.classList.remove("stagger");
        el.replaceWith(next);
        animateCounters(next);
      }
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
    window.removeEventListener("sync:progress", onSync);
    window.removeEventListener("sync:done", onSync);
    document.removeEventListener("visibilitychange", onVisible);
    clearInterval(timer);
  };
}
