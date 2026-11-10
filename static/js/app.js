// App shell: hash router, tab indicator, global "refresh all" button, sign-in.
import { api } from "./api.js";
import { fmtTime, moveIndicator, plural, toast } from "./ui.js";
import * as dashboard from "./views/dashboard.js";
import * as clients from "./views/clients.js";
import * as clientForm from "./views/client-form.js";
import * as clientDetail from "./views/client-detail.js";
import * as settings from "./views/settings.js";
import * as adminPage from "./views/admin.js";
import { showLogin } from "./views/login.js";

const ROUTES = [
  [/^#\/?(dashboard)?$/, dashboard, "dashboard"],
  [/^#\/clients$/, clients, "clients"],
  [/^#\/clients\/new$/, clientForm, "new"],
  [/^#\/clients\/(\d+)\/edit$/, clientForm, "clients"],
  [/^#\/client\/(\d+)$/, clientDetail, "dashboard"],
  [/^#\/settings$/, settings, "settings"],
  [/^#\/admin(?:\/(users|log|sessions))?$/, adminPage, "admin"],
];

const view = document.getElementById("view");
const tabs = document.getElementById("tabs");
const indicator = document.getElementById("tabs-indicator");
const locked = () => document.body.classList.contains("auth-locked");
let cleanup = null;
let renderSeq = 0;

function setActiveTab(name) {
  let active = null;
  tabs.querySelectorAll(".tab").forEach((t) => {
    const on = t.dataset.tab === name;
    t.classList.toggle("active", on);
    if (on) { active = t; t.setAttribute("aria-current", "page"); } else t.removeAttribute("aria-current");
  });
  moveIndicator(indicator, active);
}

function runCleanup() {
  if (!cleanup) return;
  try { cleanup(); } catch { /* ignore */ }
  cleanup = null;
}

async function route() {
  if (locked()) return;
  const hash = location.hash || "#/dashboard";
  let match = null;
  for (const [re, mod, tab] of ROUTES) {
    const m = re.exec(hash);
    if (m) { match = { mod, tab, params: m.slice(1).filter((x) => x !== undefined) }; break; }
  }
  if (!match) { location.replace("#/dashboard"); return; }

  const seq = ++renderSeq;
  setActiveTab(match.tab);
  runCleanup();

  if (view.childElementCount) {
    view.classList.remove("entering");
    view.classList.add("leaving");
    await new Promise((r) => setTimeout(r, 110));
    if (seq !== renderSeq) return;
  }
  view.classList.remove("leaving");
  view.innerHTML = "";
  void view.offsetWidth; // restart the enter animation
  view.classList.add("entering");
  window.scrollTo({ top: 0 });
  try {
    const dispose = (await match.mod.render(view, match.params)) || null;
    if (seq !== renderSeq) { dispose?.(); return; } // the user already went elsewhere
    cleanup = dispose;
  } catch (e) {
    if (seq !== renderSeq || e.status === 401) return; // 401 -> the login screen takes over
    console.error(e);
    view.innerHTML = "";
    if (e.status === 404) {
      toast("error", "Страница не найдена", e.message);
      location.replace("#/dashboard");
    } else {
      toast("error", "Не удалось открыть страницу", e.message);
    }
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("resize", () => moveIndicator(indicator, tabs.querySelector(".tab.active")));
document.fonts?.ready.then(() => moveIndicator(indicator, tabs.querySelector(".tab.active")));

// ---------- refresh all ----------
const syncBtn = document.getElementById("sync-all");
const syncLabel = syncBtn.querySelector(".sync-label");
const syncBar = syncBtn.querySelector(".sync-progress");
let polling = false;

function showSync(st) {
  syncBtn.classList.toggle("spinning", st.running);
  syncBtn.disabled = st.running;
  syncLabel.textContent = st.running ? `Обновляю ${st.done} из ${st.total}` : "Обновить всех";
  syncBar.style.width = st.running && st.total ? `${(st.done / st.total) * 100}%` : "0";
}

function summaryToast(st) {
  const ok = st.done - st.failed - st.skipped;
  if (st.failed) {
    const text = [ok ? `Обновлено: ${ok}` : "", `с ошибкой: ${st.failed}`].filter(Boolean).join(", ");
    toast("error", "Обновление завершено с ошибками", st.note ? `${text}. ${st.note}` : text);
  } else if (!ok) {
    toast("info", "Данные уже свежие", "Все клиенты обновлялись недавно");
  } else {
    toast("success", "Данные обновлены", plural(ok, "клиент", "клиента", "клиентов"));
  }
}

async function pollSync(announce = false) {
  if (polling) return;
  polling = true;
  let lastDone = -1;
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
        if (announce && st.total) summaryToast(st);
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } catch (e) {
    showSync({ running: false });
    if (e.status !== 401) toast("error", "Не удалось получить состояние обновления", e.message);
  } finally {
    polling = false;
  }
}

syncBtn.addEventListener("click", async () => {
  if (syncBtn.disabled) return;
  syncBtn.disabled = true;
  try {
    const st = await api.syncAll();
    if (!st.total && !st.running) {
      showSync(st);
      toast("info", "Нет клиентов для обновления", "Добавьте клиента или включите автообновление у существующих");
      return;
    }
    showSync(st);
    pollSync(true);
  } catch (e) {
    showSync({ running: false });
    if (e.status !== 401) toast("error", "Не удалось запустить обновление", e.message);
  }
});

// ---------- next scheduled run ----------
const nextRunEl = document.getElementById("next-run");
async function refreshNextRun() {
  if (locked()) return;
  try {
    const s = await api.settings();
    if (!s.schedule_enabled || !s.next_run) { nextRunEl.textContent = ""; return; }
    const d = new Date(s.next_run);
    const today = new Date().toDateString() === d.toDateString();
    nextRunEl.innerHTML = `Обновление ${today ? "в" : "завтра в"} <b>${fmtTime(d)}</b>`;
  } catch { nextRunEl.textContent = ""; }
}
window.addEventListener("settings:changed", refreshNextRun);

// Scheduled runs that start while the page is open.
async function checkBackgroundSync() {
  if (polling || locked() || document.hidden) return;
  try {
    const st = await api.syncStatus();
    if (st.running) pollSync();
  } catch { /* offline */ }
}

// ---------- sign-in ----------
let started = false;
let me = null;

function applyRole(user) {
  me = user;
  document.getElementById("admin-tab").hidden = me?.role !== "admin";
  document.getElementById("logout").title = me ? `Выйти (${me.login})` : "Выйти";
  moveIndicator(indicator, tabs.querySelector(".tab.active"));
}

async function start(user) {
  try { applyRole(user?.login ? user : await api.me()); } catch { /* handled by auth:required */ }
  document.body.classList.remove("auth-pending", "auth-locked");
  if (!started) {
    started = true;
    setInterval(refreshNextRun, 60000);
    setInterval(checkBackgroundSync, 15000);
  }
  route();
  refreshNextRun();
  checkBackgroundSync();
}

function requireLogin() {
  renderSeq++;
  applyRole(null);
  runCleanup();
  view.innerHTML = "";
  showLogin(start);
}

window.addEventListener("auth:required", requireLogin);

document.getElementById("logout").addEventListener("click", async () => {
  try { await api.logout(); } catch { /* ignore */ }
  requireLogin();
});

window.addEventListener("auth:changed", () => api.me().then(applyRole).catch(() => {}));

api.me().then(start).catch((e) => {
  if (e.status === 401) { requireLogin(); return; }
  document.body.classList.remove("auth-pending");
  toast("error", "Сервис недоступен", "Обновите страницу чуть позже");
});
