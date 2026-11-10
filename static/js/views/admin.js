// Admin panel: overview, users (passwords, access), sign-in log, sessions.
import { admin, api } from "../api.js";
import {
  avatar, confirmModal, duration, fmtTime, formModal, html, icon, mount, plural, relSpan,
  refreshRelTimes, segmented, shortUA, toast, withBusy,
} from "../ui.js";
import { formatValue } from "../metrics.js";

const TABS = [["overview", "Обзор"], ["users", "Пользователи"], ["log", "Журнал"], ["sessions", "Сессии"]];

const EVENT = {
  login: ["Вход", "ok"],
  logout: ["Выход", "never"],
  login_failed: ["Неудачный вход", "error"],
  user_created: ["Пользователь создан", "running"],
  user_updated: ["Пользователь изменён", "running"],
  user_deleted: ["Пользователь удалён", "error"],
  user_renamed: ["Логин изменён", "running"],
  password_changed: ["Пароль изменён", "running"],
  password_reset: ["Пароль сброшен", "running"],
  sessions_revoked: ["Сессии завершены", "never"],
  client_created: ["Клиент добавлен", "never"],
  client_updated: ["Клиент изменён", "never"],
  client_deleted: ["Клиент удалён", "never"],
  settings_changed: ["Настройки изменены", "never"],
  sync_all: ["Обновить всех", "never"],
};

const END_REASON = {
  logout: "вышел", revoked: "завершена админом", password_changed: "сменён пароль",
  disabled: "доступ отключён", deleted: "пользователь удалён",
};

const FIELD = { name: "название", base_url: "сайт", login: "логин", enabled: "автообновление", notes: "заметка", password: "пароль" };

const fmtDateTime = (iso) => new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
const mb = (bytes) => `${(bytes / 1024 / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
const rolePill = (role) => (role === "admin" ? html`<span class="pill admin">${icon("shield")}Админ</span>` : html`<span class="pill never">Пользователь</span>`);

function eventDetails(e) {
  const d = e.details || {};
  if (e.action === "client_updated" && d.fields) return `изменено: ${d.fields.map((f) => FIELD[f] || f).join(", ")}`;
  if (e.action === "user_updated") {
    const parts = [];
    if (d.old_login) parts.push(`логин ${d.old_login} → ${d.login}`);
    if (d.role) parts.push(d.role === "admin" ? "назначен админом" : "теперь пользователь");
    if (d.disabled !== undefined) parts.push(d.disabled ? "доступ отключён" : "доступ включён");
    return parts.join(", ");
  }
  if (e.action === "user_created" && d.role) return d.auto ? "создан автоматически" : d.role === "admin" ? "роль: админ" : "роль: пользователь";
  if (e.action === "login_failed" && d.locked_for) return `вход заблокирован на ${d.locked_for} с`;
  if (e.action === "sessions_revoked" && d.count !== undefined) return plural(d.count, "сессия", "сессии", "сессий");
  if (e.action === "user_renamed" && d.from) return `был «${d.from}»`;
  return "";
}

// ---------------------------------------------------------------- password field
function passwordField({ id, label, generate = false, help = "" }) {
  return html`<div class="field">
    <input id="${id}" type="text" placeholder=" " autocomplete="new-password" spellcheck="false" class="mono"><label for="${id}">${label}</label>
    ${generate ? html`<div class="field-tools">
      <button type="button" class="icon-btn" data-gen="${id}" title="Сгенерировать надёжный пароль" aria-label="Сгенерировать пароль">${icon("dice")}</button>
      <button type="button" class="icon-btn" data-copy="${id}" title="Скопировать" aria-label="Скопировать">${icon("copy")}</button></div>` : ""}
    ${help ? html`<div class="help">${help}</div>` : ""}
  </div>`;
}

function wirePasswordTools(form) {
  form.querySelectorAll("[data-gen]").forEach((b) => b.addEventListener("click", async () => {
    try {
      const { password } = await admin.generatePassword();
      const input = form.querySelector(`#${b.dataset.gen}`);
      input.value = password;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.focus();
      input.select();
    } catch (e) { toast("error", "Не удалось сгенерировать", e.message); }
  }));
  form.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", async () => {
    const v = form.querySelector(`#${b.dataset.copy}`).value;
    if (!v) return;
    try { await navigator.clipboard.writeText(v); toast("success", "Пароль скопирован"); } catch { toast("info", "Скопируйте пароль вручную"); }
  }));
}

// ---------------------------------------------------------------- overview
async function renderOverview(el, ctx) {
  const o = await admin.overview();
  if (!el.isConnected) return;
  const maxVisits = Math.max(1, ...o.days.map((d) => d.visits));
  const dbPct = Math.min(100, (o.db_bytes / o.db_limit_bytes) * 100);
  const sync = o.sync || {};
  mount(el, html`
    <div class="tiles admin-tiles stagger">
      <div class="tile accent" style="--i:0">
        <div class="tile-label">Сейчас на сайте</div>
        <div class="tile-value"><span class="live-dot ${o.online.length ? "on" : ""}"></span><span data-count="${o.online.length}" data-kind="count">${o.online.length}</span></div>
        <div class="tile-foot"><span>активность за последние ${o.online_minutes} мин</span></div>
      </div>
      <div class="tile accent" style="--i:1">
        <div class="tile-label">Входов сегодня</div>
        <div class="tile-value"><span data-count="${o.logins_today}" data-kind="count">${o.logins_today}</span></div>
        <div class="tile-foot"><span>${plural(o.users_today, "человек", "человека", "человек")}</span></div>
      </div>
      <div class="tile ${o.failed_24h ? "poor" : "excellent"}" style="--i:2">
        <div class="tile-label">Неудачных входов за сутки</div>
        <div class="tile-value"><span data-count="${o.failed_24h}" data-kind="count">${o.failed_24h}</span></div>
        <div class="tile-foot"><span>${o.failed_24h ? html`<a href="#/admin/log" class="link" data-kind="failed">посмотреть в журнале</a>` : "попыток подбора нет"}</span></div>
      </div>
      <div class="tile ${dbPct > 85 ? "poor" : dbPct > 60 ? "good" : "accent"}" style="--i:3">
        <div class="tile-label">База данных</div>
        <div class="tile-value">${mb(o.db_bytes)}</div>
        <div class="tile-foot"><span>из ${mb(o.db_limit_bytes)} бесплатного тарифа</span><span class="tile-exec">${formatValue(Math.round(dbPct * 10) / 10, "percent")}</span></div>
        <div class="meter"><i style="--w:${dbPct}%"></i></div>
      </div>
      <div class="tile accent" style="--i:4">
        <div class="tile-label">Пользователи</div>
        <div class="tile-value">${o.users_total}</div>
        <div class="tile-foot"><span>${plural(o.admins, "админ", "админа", "админов")}${o.users_disabled ? `, отключено: ${o.users_disabled}` : ""}</span></div>
      </div>
      <div class="tile ${o.clients_error ? "poor" : "accent"}" style="--i:5">
        <div class="tile-label">Клиенты</div>
        <div class="tile-value">${o.clients_total}</div>
        <div class="tile-foot"><span>${o.clients_error ? `с ошибкой: ${o.clients_error}` : `обновляются: ${o.clients_enabled}`}</span></div>
      </div>
      <div class="tile accent" style="--i:6">
        <div class="tile-label">Последнее обновление данных</div>
        <div class="tile-value small">${sync.running ? "идёт сейчас" : sync.finished_at ? relSpan(sync.finished_at) : "—"}</div>
        <div class="tile-foot"><span>${sync.running ? `${sync.done} из ${sync.total}` : sync.finished_at ? `${sync.trigger === "schedule" ? "по расписанию" : "вручную"}, с ошибкой: ${sync.failed}` : "с момента запуска сервера не было"}</span></div>
      </div>
    </div>

    <div class="admin-grid">
      <section class="card">
        <h3 class="card-title">Посещения за 14 дней</h3>
        <div class="bars" role="img" aria-label="Количество входов на сайт по дням">
          ${o.days.map((d, i) => {
            const day = new Date(`${d.day}T00:00:00`);
            const today = i === o.days.length - 1;
            return html`<div class="bar-col ${today ? "today" : ""}" title="${day.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: ${plural(d.visits, "посещение", "посещения", "посещений")}, ${plural(d.people, "человек", "человека", "человек")}">
              <span class="bar-val">${d.visits || ""}</span>
              <i style="--h:${(d.visits / maxVisits) * 100}%;--i:${i}"></i>
              <span class="bar-x">${day.getDate()}</span></div>`;
          })}
        </div>
      </section>
      <section class="card">
        <h3 class="card-title">На сайте сейчас</h3>
        ${o.online.length
          ? html`<ul class="people">${o.online.map((u) => html`<li>
              ${avatar(u.login)}
              <div class="who"><div class="name">${u.login} ${u.role === "admin" ? html`<span class="pill admin">${icon("shield")}Админ</span>` : ""}</div>
                <div class="sub">на сайте с ${fmtTime(new Date(u.since))} · ${duration(u.since, new Date().toISOString())}</div></div>
              <div class="meta"><div>${shortUA(u.user_agent)}</div><div class="sub">${u.ip || ""}</div></div>
            </li>`)}</ul>`
          : html`<p class="muted-text">Сейчас никого нет</p>`}
      </section>
    </div>`);
  el.querySelector('[data-kind="failed"]')?.addEventListener("click", () => sessionStorage.setItem("logKind", "failed"));
}

// ---------------------------------------------------------------- users
async function renderUsers(el, ctx) {
  const users = await admin.users();
  if (!el.isConnected) return;
  const me = ctx.me.login.toLowerCase();
  mount(el, html`
    <div class="section-head">
      <p class="muted-text">${plural(users.length, "пользователь", "пользователя", "пользователей")}. Обычные пользователи видят дашборд и клиентов, админ — ещё и эту панель.</p>
      <button class="btn btn-primary" id="add-user">${icon("plus")} Добавить пользователя</button>
    </div>
    <div class="table-wrap"><table class="grid users-table">
      <thead><tr><th>Пользователь</th><th>Роль</th><th>Статус</th><th>Последний вход</th><th>Доступ</th><th></th></tr></thead>
      <tbody>${users.map((u, i) => {
        const self = u.login.toLowerCase() === me;
        return html`<tr style="--i:${i}" data-id="${u.id}" class="${u.disabled ? "is-disabled" : ""}">
          <td><div class="client-cell">${avatar(u.login)}<span><div class="name">${u.login}${self ? html` <span class="you">это вы</span>` : ""}</div>
            <div class="sub">создан ${new Date(u.created_at).toLocaleDateString("ru-RU")}</div></span></div></td>
          <td>${rolePill(u.role)}</td>
          <td>${u.disabled ? html`<span class="pill error">Отключён</span>`
            : u.online ? html`<span class="status-line"><span class="dot ok"></span>на сайте</span>`
            : u.last_seen_at ? html`<span class="cell-muted">был ${relSpan(u.last_seen_at)}</span>` : html`<span class="cell-muted">ещё не заходил</span>`}</td>
          <td class="cell-muted">${u.last_login_at ? fmtDateTime(u.last_login_at) : "—"}</td>
          <td><label class="switch" title="${self ? "Нельзя отключить самого себя" : u.disabled ? "Включить доступ" : "Отключить доступ"}"><input type="checkbox" data-act="toggle" aria-label="Доступ" ${u.disabled ? "" : "checked"} ${self ? "disabled" : ""}><span></span></label></td>
          <td><div class="row-actions">
            <button class="icon-btn" data-act="password" title="${self ? "Сменить мой пароль" : "Задать новый пароль"}" aria-label="Пароль">${icon("key")}</button>
            <button class="icon-btn" data-act="edit" title="Логин и роль" aria-label="Изменить">${icon("edit")}</button>
            <button class="icon-btn" data-act="logout" title="Завершить все сессии" aria-label="Завершить сессии" ${u.open_sessions ? "" : "disabled"}>${icon("logout")}</button>
            <button class="icon-btn danger" data-act="delete" title="${self ? "Нельзя удалить самого себя" : "Удалить"}" aria-label="Удалить" ${self ? "disabled" : ""}>${icon("trash")}</button>
          </div></td>
        </tr>`;
      })}</tbody></table></div>`);

  const reload = () => renderUsers(el, ctx);

  el.querySelector("#add-user").addEventListener("click", async () => {
    const ok = await formModal({
      title: "Новый пользователь",
      body: html`
        <div class="field"><input id="u-login" placeholder=" " spellcheck="false" autocomplete="off"><label for="u-login">Логин</label></div>
        ${passwordField({ id: "u-pass", label: "Пароль", generate: true, help: "Не короче 6 символов. Скопируйте его, чтобы передать пользователю." })}
        <div class="role-pick" role="radiogroup" aria-label="Роль">
          <label><input type="radio" name="role" value="user" checked><span><b>Пользователь</b><small>дашборд, клиенты, настройки</small></span></label>
          <label><input type="radio" name="role" value="admin"><span><b>Администратор</b><small>плюс эта панель</small></span></label>
        </div>`,
      submitText: "Создать",
      onOpen: wirePasswordTools,
      onSubmit: (f) => admin.createUser({
        login: f.querySelector("#u-login").value.trim(),
        password: f.querySelector("#u-pass").value,
        role: f.querySelector("input[name=role]:checked").value,
      }),
    });
    if (ok) { toast("success", "Пользователь создан"); reload(); }
  });

  el.querySelector("tbody").addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const box = e.target;
    const u = users.find((x) => x.id === +box.closest("tr").dataset.id);
    box.disabled = true;
    try {
      await admin.updateUser(u.id, { disabled: !box.checked });
      toast("success", box.checked ? "Доступ включён" : "Доступ отключён", box.checked ? u.login : `${u.login} больше не сможет войти`);
      reload();
    } catch (err) {
      box.checked = !box.checked;
      box.disabled = false;
      toast("error", "Не удалось изменить", err.message);
    }
  });

  el.querySelector("tbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const u = users.find((x) => x.id === +btn.closest("tr").dataset.id);
    const self = u.login.toLowerCase() === me;
    const act = btn.dataset.act;

    if (act === "password") {
      const ok = await formModal({
        title: self ? "Сменить мой пароль" : `Новый пароль для «${u.login}»`,
        text: self ? "Другие ваши сессии будут завершены, эта останется." : "Пользователь будет сразу выведен с сайта и войдёт уже с новым паролем.",
        body: html`${self ? html`<div class="field"><input id="p-cur" type="password" placeholder=" " autocomplete="current-password"><label for="p-cur">Текущий пароль</label></div>` : ""}
          ${passwordField({ id: "p-new", label: "Новый пароль", generate: true, help: "Не короче 6 символов" })}`,
        submitText: "Сохранить пароль",
        onOpen: wirePasswordTools,
        onSubmit: (f) => {
          const password = f.querySelector("#p-new").value;
          if (password.length < 6) throw new Error("Пароль должен быть не короче 6 символов");
          return admin.setPassword(u.id, { password, current_password: f.querySelector("#p-cur")?.value });
        },
      });
      if (ok) { toast("success", "Пароль изменён", self ? "" : `${u.login} должен войти заново`); reload(); }
    }

    if (act === "edit") {
      const ok = await formModal({
        title: `Пользователь «${u.login}»`,
        body: html`<div class="field"><input id="e-login" placeholder=" " value="${u.login}" spellcheck="false"><label for="e-login">Логин</label></div>
          <div class="role-pick" role="radiogroup" aria-label="Роль">
            <label><input type="radio" name="role" value="user" ${u.role === "user" ? "checked" : ""} ${self ? "disabled" : ""}><span><b>Пользователь</b><small>дашборд, клиенты, настройки</small></span></label>
            <label><input type="radio" name="role" value="admin" ${u.role === "admin" ? "checked" : ""} ${self ? "disabled" : ""}><span><b>Администратор</b><small>плюс эта панель</small></span></label>
          </div>${self ? html`<p class="help">Свою роль изменить нельзя.</p>` : ""}`,
        onSubmit: (f) => admin.updateUser(u.id, {
          login: f.querySelector("#e-login").value.trim(),
          role: f.querySelector("input[name=role]:checked").value,
        }),
      });
      if (ok) {
        toast("success", "Изменения сохранены");
        if (self) ctx.onSelfRenamed?.();
        reload();
      }
    }

    if (act === "logout") {
      const yes = await confirmModal({
        title: `Завершить сессии «${u.login}»?`,
        text: self ? "Вы выйдете на всех остальных устройствах, здесь останетесь." : "Пользователь будет выведен с сайта на всех устройствах. Войти снова он сможет своим паролем.",
        confirmText: "Завершить",
      });
      if (!yes) return;
      try {
        const r = await admin.logoutUser(u.id);
        toast("success", r.ended ? `Завершено: ${plural(r.ended, "сессия", "сессии", "сессий")}` : "Активных сессий не было");
        reload();
      } catch (err) { toast("error", "Не удалось", err.message); }
    }

    if (act === "delete") {
      const yes = await confirmModal({
        title: `Удалить «${u.login}»?`,
        text: "Пользователь потеряет доступ к сайту. Записи в журнале останутся.",
        confirmText: "Удалить",
        danger: true,
      });
      if (!yes) return;
      try { await admin.deleteUser(u.id); toast("success", "Пользователь удалён", u.login); reload(); } catch (err) { toast("error", "Не удалось удалить", err.message); }
    }
  });
}

// ---------------------------------------------------------------- log
async function renderLog(el, ctx) {
  const users = await admin.users().catch(() => []);
  let kind = sessionStorage.getItem("logKind") || "";
  sessionStorage.removeItem("logKind");
  let login = "";
  let rows = [];
  let done = false;

  mount(el, html`
    <div class="section-head">
      <div class="segmented" id="log-kind">
        ${[["", "Все"], ["auth", "Входы и выходы"], ["failed", "Неудачные входы"], ["users", "Пользователи"], ["data", "Клиенты и настройки"]]
          .map(([v, t]) => html`<button data-value="${v}" class="${kind === v ? "active" : ""}">${t}</button>`)}
      </div>
      <select id="log-user" class="select" aria-label="Пользователь">
        <option value="">Все пользователи</option>
        ${users.map((u) => html`<option value="${u.login}">${u.login}</option>`)}
      </select>
    </div>
    <div id="log-body"></div>
    <div class="more"><button class="btn btn-ghost" id="more" hidden>Показать ещё</button></div>`);

  const body = el.querySelector("#log-body");
  const more = el.querySelector("#more");

  const rowHtml = (e, i) => {
    const [label, tone] = EVENT[e.action] || [e.action, "never"];
    const extra = eventDetails(e);
    return html`<tr style="--i:${Math.min(i, 14)}">
      <td class="cell-muted nowrap">${fmtDateTime(e.at)}</td>
      <td>${e.actor ? html`<span class="who-inline">${avatar(e.actor)}${e.actor}</span>` : html`<span class="cell-muted">${e.action === "login_failed" ? "неизвестный" : "система"}</span>`}</td>
      <td><span class="pill ${tone}">${label}</span></td>
      <td>${e.target ? html`<b class="target">${e.target}</b>` : ""}${extra ? html`<div class="sub">${extra}</div>` : ""}</td>
      <td class="cell-muted nowrap">${e.ip || "—"}</td>
      <td class="cell-muted nowrap">${shortUA(e.user_agent)}</td>
    </tr>`;
  };

  function draw() {
    if (!rows.length) {
      mount(body, html`<div class="empty"><h3>Записей нет</h3><p>Попробуйте другой фильтр</p></div>`);
    } else {
      mount(body, html`<div class="table-wrap"><table class="grid log-table">
        <thead><tr><th>Время</th><th>Кто</th><th>Событие</th><th>Объект</th><th>IP</th><th>Устройство</th></tr></thead>
        <tbody>${rows.map(rowHtml)}</tbody></table></div>`);
    }
    more.hidden = done || !rows.length;
  }

  async function load(reset) {
    const page = await admin.events({ kind, login, limit: 100, before: reset ? undefined : rows.at(-1)?.id });
    if (!el.isConnected) return;
    rows = reset ? page : rows.concat(page);
    done = page.length < 100;
    draw();
  }

  segmented(el.querySelector("#log-kind"), (v) => { kind = v; load(true); });
  el.querySelector("#log-user").addEventListener("change", (e) => { login = e.target.value; load(true); });
  more.addEventListener("click", (e) => withBusy(e.currentTarget, () => load(false)));
  await load(true);
}

// ---------------------------------------------------------------- sessions
async function renderSessions(el, ctx) {
  let days = 7;
  mount(el, html`
    <div class="section-head">
      <p class="muted-text">Каждый вход — отдельная сессия. Если человек закрыл вкладку не выходя, сессия остаётся открытой, но через ${ctx.onlineMinutes || 5} мин без активности он перестаёт считаться «на сайте».</p>
      <div class="segmented" id="ses-days">
        ${[[1, "Сутки"], [7, "Неделя"], [30, "Месяц"]].map(([v, t]) => html`<button data-value="${v}" class="${days === v ? "active" : ""}">${t}</button>`)}
      </div>
    </div>
    <div id="ses-body"></div>`);
  const body = el.querySelector("#ses-body");

  async function load() {
    const rows = await admin.sessions({ days });
    if (!el.isConnected) return;
    if (!rows.length) { mount(body, html`<div class="empty"><h3>Сессий нет</h3><p>За выбранный период никто не входил</p></div>`); return; }
    const status = (s) => (s.ended_at ? html`<span class="pill never">${END_REASON[s.end_reason] || "завершена"}</span>`
      : s.online ? html`<span class="status-line"><span class="dot ok"></span>на сайте</span>`
      : html`<span class="cell-muted">не активна</span>`);
    mount(body, html`<div class="table-wrap"><table class="grid sessions-table">
      <thead><tr><th>Пользователь</th><th>Вход</th><th>Последняя активность</th><th>Выход</th><th>Длительность</th><th>Статус</th><th>Устройство</th><th></th></tr></thead>
      <tbody>${rows.map((s, i) => html`<tr style="--i:${Math.min(i, 14)}" data-sid="${s.id}">
        <td><span class="who-inline">${avatar(s.login)}${s.login}${s.id === ctx.me.sid ? html` <span class="you">эта сессия</span>` : ""}</span></td>
        <td class="cell-muted nowrap">${fmtDateTime(s.started_at)}</td>
        <td class="cell-muted nowrap">${relSpan(s.last_seen_at)}</td>
        <td class="cell-muted nowrap">${s.ended_at ? fmtDateTime(s.ended_at) : "—"}</td>
        <td class="cell-muted nowrap">${duration(s.started_at, s.ended_at || s.last_seen_at)}</td>
        <td>${status(s)}</td>
        <td class="cell-muted nowrap" title="${s.ip || ""}">${shortUA(s.user_agent)}<div class="sub">${s.ip || ""}</div></td>
        <td>${s.ended_at ? "" : html`<button class="icon-btn danger" data-end="${s.id}" title="Завершить сессию" aria-label="Завершить сессию">${icon("logout")}</button>`}</td>
      </tr>`)}</tbody></table></div>`);
  }

  body.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-end]");
    if (!b) return;
    const yes = await confirmModal({ title: "Завершить сессию?", text: "Пользователь будет выведен с сайта на этом устройстве.", confirmText: "Завершить" });
    if (!yes) return;
    try { await admin.endSession(b.dataset.end); toast("success", "Сессия завершена"); load(); } catch (err) { toast("error", "Не удалось", err.message); }
  });
  segmented(el.querySelector("#ses-days"), (v) => { days = +v; load(); });
  await load();
}

// ---------------------------------------------------------------- page
const RENDER = { overview: renderOverview, users: renderUsers, log: renderLog, sessions: renderSessions };

export async function render(root, [tabParam]) {
  const me = await api.me();
  if (me.role !== "admin") { location.replace("#/dashboard"); return; }
  const tab = RENDER[tabParam] ? tabParam : "overview";
  const ctx = { me, onSelfRenamed: () => window.dispatchEvent(new Event("auth:changed")) };

  mount(root, html`
    <div class="page-head">
      <div>
        <h1 class="page-title">Админ-панель</h1>
        <div class="page-sub">Пользователи, входы на сайт и состояние сервиса</div>
      </div>
      <div class="segmented" id="admin-tabs">
        ${TABS.map(([id, t]) => html`<button data-value="${id}" class="${tab === id ? "active" : ""}">${t}</button>`)}
      </div>
    </div>
    <div id="admin-body"></div>`);

  segmented(root.querySelector("#admin-tabs"), (v) => { location.hash = v === "overview" ? "#/admin" : `#/admin/${v}`; });
  const body = root.querySelector("#admin-body");
  body.innerHTML = String(html`<div class="skeleton" style="height:240px"></div>`);
  await RENDER[tab](body, ctx);

  // keep the overview live; relative times everywhere
  const timer = setInterval(() => {
    if (document.hidden || !body.isConnected) return;
    if (tab === "overview") RENDER.overview(body, ctx).catch(() => {});
    else refreshRelTimes(body);
  }, 30000);
  return () => clearInterval(timer);
}
