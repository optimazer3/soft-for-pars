// Add / edit a client, with a connection check.
import { api } from "../api.js";
import { fmtPeriod, html, icon, mount, plural, toast, withBusy } from "../ui.js";

export async function render(root, [idParam]) {
  const id = idParam ? +idParam : null;
  const c = id ? await api.client(id) : { name: "", base_url: "", login: "", enabled: true, notes: "" };

  mount(root, html`
    ${id ? html`<a class="back" href="#/clients">${icon("arrowLeft")} Клиенты</a>` : ""}
    <div class="page-head">
      <div>
        <h1 class="page-title">${id ? c.name : "Новый клиент"}</h1>
        <div class="page-sub">${id ? "Редактирование клиента" : "Сайт Оптимайзера клиента и данные для входа"}</div>
      </div>
    </div>
    <div class="form-layout">
      <form class="card" id="form" autocomplete="off" novalidate>
        <div class="field"><input id="name" placeholder=" " value="${c.name}" maxlength="200" required><label for="name">Название клиента</label></div>
        <div class="field">
          <input id="base_url" placeholder=" " value="${c.base_url}" required spellcheck="false"><label for="base_url">Адрес сайта Оптимайзера</label>
          <div class="help">Например, demo-optics.optmzr.ru — можно вставить ссылку целиком</div>
        </div>
        <div class="field-row">
          <div class="field"><input id="login" placeholder=" " value="${c.login}" required autocomplete="off" spellcheck="false"><label for="login">Логин</label></div>
          <div class="field">
            <input id="password" type="password" placeholder=" " autocomplete="new-password"><label for="password">${id ? "Новый пароль" : "Пароль"}</label>
            <button type="button" class="icon-btn eye" id="eye" title="Показать пароль" aria-label="Показать пароль">${icon("eye")}</button>
            ${id ? html`<div class="help">Оставьте пустым, чтобы не менять</div>` : ""}
          </div>
        </div>
        <div class="field"><textarea id="notes" placeholder=" ">${c.notes}</textarea><label for="notes">Заметка (необязательно)</label></div>
        <label class="check-row"><span class="switch"><input type="checkbox" id="enabled" ${c.enabled ? "checked" : ""}><span></span></span>
          Обновлять данные по расписанию</label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="save">${icon("check")} ${id ? "Сохранить" : "Добавить клиента"}</button>
          <button type="button" class="btn" id="test">${icon("plug")} Проверить подключение</button>
          <a class="btn btn-ghost" href="${id ? "#/clients" : "#/dashboard"}">Отмена</a>
        </div>
      </form>
      <div class="side-col">
        <div id="test-out"></div>
        <div class="card tips">
          <h3>Как добавить клиента</h3>
          <ul>
            <li>${icon("check")}<span>Укажите адрес, по которому клиент заходит в Оптимайзер, и его логин с паролем.</span></li>
            <li>${icon("check")}<span>«Проверить подключение» покажет, получилось ли войти и какие салоны найдены.</span></li>
          </ul>
        </div>
      </div>
    </div>`);

  const $ = (s) => root.querySelector(s);
  const form = $("#form");
  const out = $("#test-out");
  const pwd = $("#password");

  $("#eye").addEventListener("click", () => {
    const show = pwd.type === "password";
    pwd.type = show ? "text" : "password";
    $("#eye").innerHTML = String(icon(show ? "eyeOff" : "eye"));
  });

  const values = () => ({
    name: $("#name").value.trim(),
    base_url: $("#base_url").value.trim(),
    login: $("#login").value.trim(),
    password: pwd.value || null,
    notes: $("#notes").value.trim(),
    enabled: $("#enabled").checked,
  });

  function validate(v, needPassword, needName = true) {
    let ok = true;
    $("#name").closest(".field").classList.remove("invalid");
    const req = [...(needName ? ["name"] : []), "base_url", "login", ...(needPassword ? ["password"] : [])];
    req.forEach((k) => {
      const field = $(`#${k}`).closest(".field");
      field.classList.remove("invalid");
      if (!v[k]) {
        void field.offsetWidth;
        field.classList.add("invalid");
        ok = false;
      }
    });
    if (!ok) form.querySelector(".field.invalid input")?.focus();
    return ok;
  }
  form.addEventListener("input", (e) => e.target.closest(".field")?.classList.remove("invalid"));

  $("#test").addEventListener("click", async (e) => {
    const v = values();
    if (!validate(v, !id, false)) return;
    await withBusy(e.currentTarget, async () => {
      out.innerHTML = "";
      try {
        const r = await api.testConnection({ base_url: v.base_url, login: v.login, password: v.password, client_id: id });
        if (!root.isConnected) return;
        mount(out, html`<div class="test-result ok">
          <h4>${icon("check")} Подключение работает</h4>
          <dl><dt>Сайт</dt><dd>${r.base_url.replace(/^https?:\/\//, "")}</dd>
          <dt>Период</dt><dd>${fmtPeriod(r.period)}</dd>
          <dt>Найдено</dt><dd>${plural(r.branches.length, "салон", "салона", "салонов")}</dd></dl>
          <div class="chips">${r.branches.map((b) => html`<span class="chip">${icon("store")} ${b}</span>`)}</div></div>`);
        if (!$("#name").value.trim()) $("#name").value = hostToName(r.base_url);
      } catch (err) {
        if (!root.isConnected) return;
        mount(out, html`<div class="test-result err"><h4>${icon("alert")} Не удалось подключиться</h4>${err.message}</div>`);
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = values();
    if (!validate(v, !id)) return;
    await withBusy($("#save"), async () => {
      try {
        if (id) {
          await api.updateClient(id, v);
          toast("success", "Изменения сохранены", v.name);
          location.hash = "#/clients";
        } else {
          const created = await api.createClient(v);
          toast("info", "Клиент добавлен", "Загружаю показатели…");
          location.hash = "#/dashboard";
          const notify = () => window.dispatchEvent(new CustomEvent("sync:done", { detail: {} }));
          api.syncClient(created.id).then((r) => {
            r.ok ? toast("success", "Данные загружены", created.name) : toast("error", `${created.name}: не удалось загрузить данные`, r.error);
          }).catch(() => {}).finally(notify);
          // Let the dashboard show the "updating" state right away.
          setTimeout(notify, 600);
        }
      } catch (err) {
        toast("error", "Не удалось сохранить", err.message);
      }
    });
  });
}

function hostToName(url) {
  try {
    const sub = new URL(url).host.split(".")[0];
    return sub.charAt(0).toUpperCase() + sub.slice(1);
  } catch { return ""; }
}
