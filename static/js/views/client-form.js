// Add / edit a client, with "test connection".
import { api } from "../api.js";
import { fmtPeriod, html, icon, mount, toast, withBusy } from "../ui.js";

export async function render(root, [idParam]) {
  const id = idParam ? +idParam : null;
  const c = id ? await api.client(id) : { name: "", base_url: "", login: "", enabled: true, notes: "" };

  mount(root, html`
    ${id ? html`<a class="back" href="#/clients">${icon("arrowLeft")} К списку клиентов</a>` : ""}
    <div class="page-head">
      <div>
        <h1 class="page-title">${id ? `Редактирование: ${c.name}` : "Новый клиент"}</h1>
        <div class="page-sub">${id ? "Измените данные и сохраните" : "Укажите сайт Оптимайзера клиента и данные для входа"}</div>
      </div>
    </div>
    <div class="form-layout">
      <form class="card" id="form" autocomplete="off" novalidate>
        <div class="field"><input id="name" placeholder=" " value="${c.name}" required><label for="name">Название клиента</label></div>
        <div class="field">
          <input id="base_url" placeholder=" " value="${c.base_url}" required><label for="base_url">Адрес сайта Оптимайзера</label>
          <div class="help">Например: demo-optics.optmzr.ru — можно вставить ссылку целиком</div>
        </div>
        <div class="field-row">
          <div class="field"><input id="login" placeholder=" " value="${c.login}" required autocomplete="off"><label for="login">Логин</label></div>
          <div class="field">
            <input id="password" type="password" placeholder=" " autocomplete="new-password"><label for="password">${id ? "Новый пароль" : "Пароль"}</label>
            <button type="button" class="icon-btn eye" id="eye" title="Показать пароль">${icon("eye")}</button>
            ${id ? html`<div class="help">Оставьте пустым, чтобы не менять</div>` : ""}
          </div>
        </div>
        <div class="field"><textarea id="notes" placeholder=" ">${c.notes}</textarea><label for="notes">Заметка (необязательно)</label></div>
        <label class="check-row"><span class="switch"><input type="checkbox" id="enabled" ${c.enabled ? "checked" : ""}><span></span></span>
          Собирать данные по расписанию</label>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="save">${icon("check")} ${id ? "Сохранить" : "Добавить клиента"}</button>
          <button type="button" class="btn" id="test">${icon("plug")} Проверить</button>
          <a class="btn btn-ghost" href="${id ? "#/clients" : "#/dashboard"}">Отмена</a>
        </div>
      </form>
      <div>
        <div id="test-out"></div>
        <div class="card tips">
          <h3>Подсказка</h3>
          <ol>
            <li>Адрес — это ссылка, по которой клиент заходит в Оптимайзер, например <code>https://demo-optics.optmzr.ru</code>.</li>
            <li>Нажмите «Проверить»: программа войдёт на сайт и покажет найденные салоны.</li>
            <li>Пароль хранится зашифрованным в файле на этом компьютере и никуда не отправляется, кроме сайта клиента.</li>
          </ol>
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
    return ok;
  }

  $("#test").addEventListener("click", async (e) => {
    const v = values();
    if (!validate(v, !id, false)) return;
    await withBusy(e.currentTarget, async () => {
      out.innerHTML = "";
      try {
        const r = await api.testConnection({ base_url: v.base_url, login: v.login, password: v.password, client_id: id });
        mount(out, html`<div class="test-result ok" style="margin-bottom:16px">
          <h4>${icon("check")} Подключение работает</h4>
          <dl><dt>Сайт</dt><dd>${r.base_url}</dd><dt>Пользователь</dt><dd>${r.user} (${r.role})</dd>
          <dt>Период</dt><dd>${fmtPeriod(r.period)}</dd><dt>Салонов</dt><dd>${r.branches.length}</dd></dl>
          <div class="chips">${r.branches.map((b) => html`<span class="chip">${icon("store")} ${b}</span>`)}</div></div>`);
        if (!$("#name").value.trim()) $("#name").value = hostToName(r.base_url);
      } catch (err) {
        mount(out, html`<div class="test-result err" style="margin-bottom:16px"><h4>${icon("alert")} Не удалось подключиться</h4>${err.message}</div>`);
      }
    });
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = values();
    if (!validate(v, !id)) { form.classList.remove("shake"); void form.offsetWidth; form.classList.add("shake"); return; }
    await withBusy($("#save"), async () => {
      try {
        if (id) {
          await api.updateClient(id, v);
          toast("success", "Изменения сохранены", v.name);
          location.hash = "#/clients";
        } else {
          const created = await api.createClient(v);
          toast("info", "Клиент добавлен", "Собираю данные…");
          location.hash = "#/dashboard";
          api.syncClient(created.id).then((r) => {
            r.ok ? toast("success", `${created.name}: данные собраны`) : toast("error", `${created.name}: ошибка сбора`, r.error);
            window.dispatchEvent(new CustomEvent("sync:done", { detail: {} }));
          }).catch(() => {});
          // Let the dashboard show the "running" state right away.
          setTimeout(() => window.dispatchEvent(new CustomEvent("sync:progress", { detail: {} })), 400);
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
