// Dashboard: every client with the key metrics of the Optimizer home page.
import { api } from "../api.js";
import { formatValue, metricKind, metricLabel, metricStatus } from "../metrics.js";
import {
  plural, avatar, debounce, fmtPeriod, hostOf, html, icon, mount, relTime, segmented,
  STATUS_TEXT, toast, withBusy, animateCounters,
} from "../ui.js";

/** One KPI tile. `prev` = previous value for the count-up animation. */
export function tile(key, m, i = 0, prev) {
  const kind = metricKind(key);
  const status = metricStatus(m);
  if (!m) {
    return html`<div class="tile empty" style="--i:${i}">
      <div class="tile-label">${metricLabel(key)}</div>
      <div class="tile-value">—</div><div class="tile-plan">нет данных</div></div>`;
  }
  const exec = m.plan ? Math.max(0, Math.min(100, m.execution || 0)) : 0;
  return html`<div class="tile ${status}" style="--i:${i}" title="${metricLabel(key)}: факт ${formatValue(m.current, kind)}, план ${formatValue(m.plan, kind)}">
    <div class="tile-label">${metricLabel(key)}</div>
    <div class="tile-value" data-count="${m.current}" data-kind="${kind}" ${prev != null ? html`data-from="${prev}"` : ""}>${formatValue(m.current, kind)}</div>
    <div class="tile-plan">
      <span>План: ${m.plan ? formatValue(m.plan, kind) : "—"}</span>
      ${m.plan ? html`<span class="exec">${formatValue(m.execution, "percent")}</span>` : ""}
    </div>
    <div class="tile-bar"><i style="--w:${exec}%"></i></div>
  </div>`;
}

function statusPill(c) {
  if (!c.enabled) return html`<span class="pill off">Выключен</span>`;
  return html`<span class="pill ${c.last_status}">${c.last_status === "running" ? icon("refresh", "spin") : ""}${STATUS_TEXT[c.last_status] || c.last_status}</span>`;
}

function panel(c, keys, i, prevKpi) {
  const s = c.snapshot;
  const running = c.last_status === "running";
  return html`<section class="panel" data-id="${c.id}" style="--i:${i}">
    <div class="panel-head">
      ${avatar(c.name)}
      <div class="panel-title">
        <h3><a href="#/client/${c.id}">${c.name}</a> ${statusPill(c)}</h3>
        <div class="panel-meta">
          <a href="${c.base_url}" target="_blank" rel="noopener">${hostOf(c.base_url)}</a>
          ${s ? html`<span>${icon("calendar")} ${fmtPeriod(s.period)}</span>` : ""}
          ${s ? html`<span>${plural(s.branches_count, "салон", "салона", "салонов")}</span>` : ""}
          <span title="${c.last_sync_at || ""}">Обновлено: ${relTime(c.last_sync_at)}</span>
          ${s?.source_updated_at ? html`<span>Данные Оптимайзера от ${new Date(s.source_updated_at).toLocaleDateString("ru-RU")}</span>` : ""}
        </div>
      </div>
      <div class="panel-actions">
        <button class="icon-btn" data-act="sync" title="Обновить сейчас" ${running ? "disabled" : ""}>${icon("refresh", running ? "spin" : "")}</button>
        <a class="icon-btn" href="#/clients/${c.id}/edit" title="Редактировать">${icon("edit")}</a>
        <a class="btn btn-sm" href="#/client/${c.id}">Подробнее ${icon("arrowRight")}</a>
      </div>
    </div>
    ${c.last_status === "error" && c.last_error ? html`<div class="error-banner">${icon("alert")}<div><b>Не удалось собрать данные.</b> ${c.last_error}</div></div>` : ""}
    ${s
      ? html`<div class="tiles stagger">${keys.map((k, j) => tile(k, s.kpi[k], j, prevKpi?.[k]?.current))}</div>`
      : html`<div class="empty" style="padding:28px">
          <p style="margin:0 0 14px">Данные ещё не собраны</p>
          <button class="btn btn-primary btn-sm" data-act="sync">${icon("refresh")} Собрать сейчас</button></div>`}
  </section>`;
}

function cellKpi(key, m) {
  if (!m) return html`<span class="cell-kpi"><span class="v" style="color:var(--muted)">—</span></span>`;
  const kind = metricKind(key);
  return html`<span class="cell-kpi">
    <span class="v"><span class="dot ${metricStatus(m)}"></span>${formatValue(m.current, kind)}</span>
    <span class="p">план ${m.plan ? formatValue(m.plan, kind) : "—"}</span></span>`;
}

function skeleton() {
  return html`<div class="page-head"><div><div class="skeleton" style="width:200px;height:30px"></div></div></div>
    <div class="panels">${[0, 1].map(() => html`<div class="panel">
      <div class="skeleton" style="width:260px;height:42px;margin-bottom:16px"></div>
      <div class="tiles">${Array.from({ length: 10 }, () => html`<div class="skeleton" style="height:112px"></div>`)}</div></div>`)}</div>`;
}

export async function render(root) {
  mount(root, skeleton());
  let data = await api.dashboard();
  let mode = localStorage.getItem("dashMode") || "cards";
  let query = "";
  let sort = { key: "name", dir: 1 };

  const visible = () => {
    const q = query.trim().toLowerCase();
    let list = data.clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.base_url.includes(q));
    if (mode === "table") {
      const val = (c) => sort.key === "name" ? c.name.toLowerCase() : (c.snapshot?.kpi[sort.key]?.current ?? -Infinity);
      list = [...list].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * sort.dir);
    }
    return list;
  };

  function headHtml() {
    const total = data.clients.length;
    const ok = data.clients.filter((c) => c.last_status === "ok").length;
    const err = data.clients.filter((c) => c.last_status === "error").length;
    const periods = [...new Set(data.clients.map((c) => c.snapshot?.period).filter(Boolean))];
    return html`<div class="page-head">
      <div>
        <h1 class="page-title">Дашборд</h1>
        <div class="page-sub">
          <span class="chip">Клиентов <b>${total}</b></span>
          <span class="chip"><span class="dot ok"></span>Собрано <b>${ok}</b></span>
          ${err ? html`<span class="chip"><span class="dot error"></span>Ошибок <b>${err}</b></span>` : ""}
          ${periods.length === 1 ? html`<span class="chip">${icon("calendar")} ${fmtPeriod(periods[0])}</span>` : ""}
        </div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search")}<input id="q" placeholder="Поиск клиента…" value="${query}"></label>
        <div class="segmented" id="mode">
          <button data-value="cards" class="${mode === "cards" ? "active" : ""}">${icon("grid")} Карточки</button>
          <button data-value="table" class="${mode === "table" ? "active" : ""}">${icon("table")} Таблица</button>
        </div>
      </div>
    </div>`;
  }

  function bodyHtml(prev = {}) {
    const list = visible();
    if (!data.clients.length) {
      return html`<div class="empty">
        <div class="big-ico">${icon("users")}</div>
        <h3>Пока нет ни одного клиента</h3>
        <p>Добавьте адрес сайта Оптимайзера, логин и пароль — и данные появятся здесь.</p>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a></div>`;
    }
    if (!list.length) return html`<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте другой запрос</p></div>`;
    if (mode === "cards") {
      return html`<div class="panels stagger">${list.map((c, i) => panel(c, data.key_metrics, i, prev[c.id]))}</div>`;
    }
    const th = (key, label, num = true) => html`<th class="sortable ${num ? "num" : ""} ${sort.key === key ? `sorted ${sort.dir < 0 ? "desc" : ""}` : ""}" data-sort="${key}">${label}<span class="arrow">▲</span></th>`;
    return html`<div class="table-wrap"><table class="grid kpi-table">
      <thead><tr>${th("name", "Клиент", false)}${data.key_metrics.map((k) => th(k, metricLabel(k)))}<th></th></tr></thead>
      <tbody>${list.map((c, i) => html`<tr style="--i:${i}" data-id="${c.id}">
        <td><a class="client-cell" href="#/client/${c.id}">${avatar(c.name)}<span>
          <div class="name">${c.name}</div>
          <div class="sub"><span class="dot ${c.last_status}" style="display:inline-block;margin-right:5px"></span>${relTime(c.last_sync_at)}</div></span></a></td>
        ${data.key_metrics.map((k) => html`<td class="num">${cellKpi(k, c.snapshot?.kpi[k])}</td>`)}
        <td><div class="row-actions"><button class="icon-btn" data-act="sync" title="Обновить">${icon("refresh", c.last_status === "running" ? "spin" : "")}</button></div></td>
      </tr>`)}</tbody></table></div>`;
  }

  mount(root, html`<div id="dash-head"></div><div id="dash-body"></div>`);
  const headEl = root.querySelector("#dash-head");
  const bodyEl = root.querySelector("#dash-body");

  function drawHead() {
    mount(headEl, headHtml());
    const input = headEl.querySelector("#q");
    input.addEventListener("input", debounce(() => { query = input.value; drawBody(); }, 120));
    segmented(headEl.querySelector("#mode"), (v) => {
      mode = v;
      localStorage.setItem("dashMode", v);
      drawBody();
    });
  }
  const drawBody = (prev) => mount(bodyEl, bodyHtml(prev));
  drawHead();
  drawBody();

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
    if (!btn) return;
    const id = +btn.closest("[data-id]").dataset.id;
    const client = data.clients.find((c) => c.id === id);
    await withBusy(btn, async () => {
      try {
        const res = await api.syncClient(id);
        res.ok
          ? toast("success", `${client.name}: данные обновлены`)
          : toast("error", `${client.name}: ошибка сбора`, res.error);
      } catch (err) {
        toast("error", "Ошибка", err.message);
      }
    });
    await refresh([id]);
  });

  // ---- live refresh while a global sync is running ----
  async function refresh(onlyIds) {
    const old = data;
    try { data = await api.dashboard(); } catch { return; }
    if (!root.isConnected) return;
    const prevKpi = Object.fromEntries(old.clients.map((c) => [c.id, c.snapshot?.kpi]));
    const changed = data.clients.filter((c) => {
      const o = old.clients.find((x) => x.id === c.id);
      return !o || o.last_sync_at !== c.last_sync_at || o.last_status !== c.last_status;
    }).map((c) => c.id);
    const ids = onlyIds || changed;
    drawHead();
    if (mode !== "cards" || old.clients.length !== data.clients.length) { drawBody(prevKpi); return; }
    for (const id of ids) {
      const el = bodyEl.querySelector(`.panel[data-id="${id}"]`);
      const idx = data.clients.findIndex((c) => c.id === id);
      if (!el || idx < 0) continue;
      const tmp = document.createElement("div");
      tmp.innerHTML = String(panel(data.clients[idx], data.key_metrics, 0, prevKpi[id]));
      const fresh = tmp.firstElementChild;
      fresh.classList.add("flash");
      fresh.querySelector(".tiles")?.classList.remove("stagger");
      el.replaceWith(fresh);
      animateCounters(fresh);
    }
  }
  const onProgress = () => refresh();
  window.addEventListener("sync:progress", onProgress);
  window.addEventListener("sync:done", onProgress);
  return () => {
    window.removeEventListener("sync:progress", onProgress);
    window.removeEventListener("sync:done", onProgress);
  };
}
