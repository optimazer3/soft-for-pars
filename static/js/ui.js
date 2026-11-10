// Small UI toolkit: safe HTML templates, icons, toasts, modals, animations.
import { formatValue } from "./metrics.js";

// ---------- templates ----------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export const raw = (s) => new Raw(String(s));

function part(v) {
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

/** Tagged template: interpolated values are escaped unless wrapped with raw() / html``. */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]; });
  return new Raw(out);
}

export function mount(el, tpl) {
  el.innerHTML = String(tpl);
  animateCounters(el);
  return el;
}

// ---------- icons ----------
const P = {
  refresh: '<path d="M21 12a9 9 0 0 1-15.4 6.4L3 16M3 12a9 9 0 0 1 15.4-6.4L21 8M21 3v5h-5M3 21v-5h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M10 11v6M14 11v6"/>',
  external: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c6.5 0 10 8 10 8a17 17 0 0 1-2.2 3.2M6.6 6.6A17 17 0 0 0 2 12s3.5 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a6 6 0 0 1-12 0V8Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  store: '<path d="M3 9 4.5 4h15L21 9M3 9v11h18V9M3 9h18M9 20v-6h6v6"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
};
export const icon = (name, cls = "") => raw(`<svg class="${cls}" viewBox="0 0 24 24">${P[name] || ""}</svg>`);

// ---------- misc helpers ----------
export function initials(name) {
  const w = String(name || "?").trim().split(/\s+/);
  return ((w[0]?.[0] || "?") + (w[1]?.[0] || "")).toUpperCase();
}
export function hue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
export const avatar = (name) => html`<span class="avatar" style="--h:${hue(name)}">${initials(name)}</span>`;
export const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

export function relTime(iso) {
  if (!iso) return "никогда";
  const d = new Date(iso);
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 45) return "только что";
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400 && new Date().getDate() === d.getDate()) return `сегодня в ${fmtTime(d)}`;
  if (s < 172800) return `вчера в ${fmtTime(d)}`;
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
/** Relative time that can be refreshed in place (see refreshRelTimes). */
export const relSpan = (iso) => html`<span data-rel="${iso || ""}" title="${iso ? new Date(iso).toLocaleString("ru-RU") : ""}">${relTime(iso)}</span>`;
export function refreshRelTimes(root) {
  root.querySelectorAll("[data-rel]").forEach((el) => { el.textContent = relTime(el.dataset.rel); });
}
export const fmtTime = (d) => d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

/** "2026-11-07" -> "07.11.2026" without time-zone shifts. */
export function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "";
}

/** Toast for a failed manual refresh (429 = data is still fresh, not an error). */
export function syncErrorToast(err) {
  err.status === 429 ? toast("info", "Данные ещё свежие", err.message) : toast("error", "Не удалось обновить", err.message);
}

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export function fmtPeriod(p) {
  const m = /^(\d{4})-(\d{2})$/.exec(p || "");
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : p || "";
}

export function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
  return `${n} ${w}`;
}

export const STATUS_TEXT = { ok: "Обновлено", error: "Ошибка", running: "Обновляется…", never: "Нет данных" };

export function debounce(fn, ms = 150) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- animated counters ----------
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let counters = [];
let rafId = 0;

/** Animate every [data-count] element inside root from data-from (or 0) to its value. */
export function animateCounters(root) {
  const els = root.querySelectorAll("[data-count]");
  const now = performance.now();
  els.forEach((el, i) => {
    const to = parseFloat(el.dataset.count);
    const from = parseFloat(el.dataset.from ?? "0");
    const kind = el.dataset.kind;
    if (reduceMotion || Number.isNaN(to) || from === to) {
      el.textContent = formatValue(to, kind);
      return;
    }
    const decimals = Number.isInteger(to) && kind !== "percent" ? 0 : 1;
    counters.push({ el, from, to, kind, decimals, start: now + Math.min(i, 30) * 12, dur: 900 });
  });
  if (counters.length && !rafId) rafId = requestAnimationFrame(tick);
}

function tick(t) {
  counters = counters.filter((c) => {
    const p = Math.min(1, Math.max(0, (t - c.start) / c.dur));
    const e = 1 - Math.pow(1 - p, 4);
    let v = c.from + (c.to - c.from) * e;
    v = p >= 1 ? c.to : Number(v.toFixed(c.decimals));
    c.el.textContent = formatValue(v, c.kind);
    return p < 1;
  });
  rafId = counters.length ? requestAnimationFrame(tick) : 0;
}

// ---------- sliding indicators (tabs / segmented) ----------
export function moveIndicator(indicator, target) {
  if (!indicator) return;
  if (!target) { indicator.style.opacity = "0"; return; }
  indicator.style.opacity = "1";
  indicator.style.width = `${target.offsetWidth}px`;
  indicator.style.transform = `translateX(${target.offsetLeft}px)`;
}

/** Wire a .segmented control: calls onChange(value) and slides the indicator. */
export function segmented(root, onChange) {
  const ind = document.createElement("span");
  ind.className = "seg-indicator";
  root.prepend(ind);
  const sync = () => moveIndicator(ind, root.querySelector("button.active"));
  requestAnimationFrame(sync);
  root.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b || b.classList.contains("active")) return;
    root.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
    sync();
    onChange(b.dataset.value);
  });
  return sync;
}

// ---------- toasts ----------
export function toast(type, title, text = "") {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = String(html`${icon(type === "success" ? "check" : type === "error" ? "alert" : "info")}
    <div><div class="t-title">${title}</div>${text ? html`<div class="t-text">${text}</div>` : ""}</div>`);
  box.appendChild(el);
  const close = () => { el.classList.add("out"); el.addEventListener("animationend", () => el.remove()); };
  setTimeout(close, type === "error" ? 6500 : 3500);
  el.addEventListener("click", close);
}

// ---------- confirm modal ----------
export function confirmModal({ title, text, confirmText = "Подтвердить", danger = false }) {
  return new Promise((resolve) => {
    const root = document.getElementById("modal-root");
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    bd.innerHTML = String(html`<div class="modal" role="dialog" aria-modal="true">
      <h3>${title}</h3><p>${text}</p>
      <div class="actions">
        <button class="btn btn-ghost" data-act="no">Отмена</button>
        <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-act="yes">${confirmText}</button>
      </div></div>`);
    root.appendChild(bd);
    bd.querySelector('[data-act="yes"]').focus();
    const done = (v) => {
      document.removeEventListener("keydown", onKey);
      bd.classList.add("out");
      setTimeout(() => bd.remove(), 200);
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") done(false); };
    document.addEventListener("keydown", onKey);
    bd.addEventListener("click", (e) => {
      if (e.target === bd) return done(false);
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act) done(act === "yes");
    });
  });
}

/** Put a button into a loading state while the promise runs. */
export async function withBusy(btn, fn) {
  btn.disabled = true;
  const svg = btn.querySelector("svg");
  svg?.classList.add("spin");
  try { return await fn(); } finally { btn.disabled = false; svg?.classList.remove("spin"); }
}
