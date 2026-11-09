// App shell: hash router, tab indicator, global "sync all" button.
import { api } from "./api.js";
import { fmtTime, moveIndicator, toast } from "./ui.js";
import * as dashboard from "./views/dashboard.js";
import * as clients from "./views/clients.js";
import * as clientForm from "./views/client-form.js";
import * as clientDetail from "./views/client-detail.js";
import * as settings from "./views/settings.js";
import { showLogin } from "./views/login.js";

const ROUTES = [
  [/^#\/?(dashboard)?$/, dashboard, "dashboard"],
  [/^#\/clients$/, clients, "clients"],
  [/^#\/clients\/new$/, clientForm, "new"],
  [/^#\/clients\/(\d+)\/edit$/, clientForm, "clients"],
  [/^#\/client\/(\d+)$/, clientDetail, "dashboard"],
  [/^#\/settings$/, settings, "settings"],
];

const view = document.getElementById("view");
const tabs = document.getElementById("tabs");
const indicator = document.getElementById("tabs-indicator");
let cleanup = null;
let renderSeq = 0;

function setActiveTab(name) {
  let active = null;
  tabs.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) active = t;
  });
  moveIndicator(indicator, active);
}

async function route() {
  if (document.body.classList.contains("auth-locked")) return;
  const hash = location.hash || "#/dashboard";
  let match = null;
  for (const [re, mod, tab] of ROUTES) {
    const m = re.exec(hash);
    if (m) { match = { mod, tab, params: m.slice(1) }; break; }
  }
  if (!match) { location.hash = "#/dashboard"; return; }

  const seq = ++renderSeq;
  setActiveTab(match.tab);
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }

  if (view.childElementCount) {
    view.classList.remove("entering");
    view.classList.add("leaving");
    await new Promise((r) => setTimeout(r, 140));
    if (seq !== renderSeq) return;
  }
  view.classList.remove("leaving");
  view.innerHTML = "";
  void view.offsetWidth; // restart the enter animation
  view.classList.add("entering");
  window.scrollTo({ top: 0 });
  try {
    cleanup = (await match.mod.render(view, match.params)) || null;
  } catch (e) {
    console.error(e);
    toast("error", "Не удалось открыть страницу", e.message);
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => moveIndicator(indicator, tabs.querySelector(".tab.active")));

// ---------- global sync ----------
const syncBtn = document.getElementById("sync-all");
const syncLabel = syncBtn.querySelector(".sync-label");
const syncBar = syncBtn.querySelector(".sync-progress");
let polling = false;
let lastDone = -1;

function showSync(st) {
  syncBtn.classList.toggle("spinning", st.running);
  syncBtn.disabled = st.running;
  if (st.running) {
    syncLabel.textContent = `Собираю ${st.done}/${st.total}`;
    syncBar.style.width = st.total ? `${(st.done / st.total) * 100}%` : "0";
  } else {
    syncLabel.textContent = "Обновить всех";
    syncBar.style.width = "0";
  }
}

export async function pollSync() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const st = await api.syncStatus();
      showSync(st);
      if (st.done !== lastDone) {
        lastDone = st.done;
        window.dispatchEvent(new CustomEvent("sync:progress", { detail: st }));
      }
      if (!st.running) {
        window.dispatchEvent(new CustomEvent("sync:done", { detail: st }));
        if (st.total && st.trigger === "manual") {
          const ok = st.done - st.failed - st.skipped;
          const parts = [`Обновлено: ${ok}`];
          if (st.skipped) parts.push(`уже свежие: ${st.skipped}`);
          if (st.failed) parts.push(`с ошибкой: ${st.failed}`);
          parts.push(`запросов к сайтам: ${st.requests}`);
          const text = parts.join(" · ") + (st.note ? `. ${st.note}` : "");
          if (st.failed) toast("error", "Сбор завершён с ошибками", text);
          else if (!ok) toast("info", "Данные уже свежие", "Все клиенты обновлялись недавно — запросы на сайты не отправлялись");
          else toast("success", "Сбор завершён", text);
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    toast("error", "Ошибка опроса статуса", e.message);
  } finally {
    polling = false;
    lastDone = -1;
  }
}

syncBtn.addEventListener("click", async () => {
  try {
    const st = await api.syncAll();
    if (!st.total && !st.running) {
      toast("info", "Нет активных клиентов", "Добавьте клиента или включите существующих");
      return;
    }
    showSync(st);
    pollSync();
  } catch (e) {
    toast("error", "Не удалось запустить сбор", e.message);
  }
});

// ---------- next scheduled run ----------
const nextRunEl = document.getElementById("next-run");
export async function refreshNextRun() {
  if (document.body.classList.contains("auth-locked")) return;
  try {
    const s = await api.settings();
    if (!s.schedule_enabled || !s.next_run) {
      nextRunEl.innerHTML = "Авто-сбор <b>выключен</b>";
      return;
    }
    const d = new Date(s.next_run);
    const today = new Date().toDateString() === d.toDateString();
    nextRunEl.innerHTML = `Следующий сбор: <b>${today ? "" : "завтра "}${fmtTime(d)}</b>`;
  } catch { nextRunEl.textContent = ""; }
}
window.addEventListener("settings:changed", refreshNextRun);
window.addEventListener("sync:start", () => pollSync());

// Catch scheduled runs that start while the page is open.
setInterval(async () => {
  if (polling || document.body.classList.contains("auth-locked")) return;
  try {
    const st = await api.syncStatus();
    if (st.running) pollSync();
  } catch { /* server offline */ }
}, 15000);

// ---------- auth ----------
let started = false;

function start() {
  document.body.classList.remove("auth-pending", "auth-locked");
  if (!started) {
    started = true;
    setInterval(refreshNextRun, 60000);
  }
  route();
  refreshNextRun();
  api.syncStatus().then((st) => { if (st.running) pollSync(); }).catch(() => {});
}

function requireLogin() {
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  view.innerHTML = "";
  showLogin(start);
}

window.addEventListener("auth:required", requireLogin);

document.getElementById("logout").addEventListener("click", async () => {
  try { await api.logout(); } catch { /* ignore */ }
  requireLogin();
});

api.me().then(start).catch(requireLogin);
