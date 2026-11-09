// Clients list: status, enable/disable, sync, edit, delete.
import { api } from "../api.js";
import {
  avatar, confirmModal, debounce, hostOf, html, icon, mount, relTime, STATUS_TEXT, toast, withBusy,
} from "../ui.js";

export async function render(root) {
  let clients = await api.clients();
  let query = "";

  mount(root, html`
    <div class="page-head">
      <div>
        <h1 class="page-title">Клиенты</h1>
        <div class="page-sub">Сайты Оптимайзера, с которых собираются данные</div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search")}<input id="q" placeholder="Поиск клиента…"></label>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a>
      </div>
    </div>
    <div id="list"></div>`);
  const list = root.querySelector("#list");

  function draw() {
    const q = query.trim().toLowerCase();
    const rows = clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.base_url.includes(q) || c.login.toLowerCase().includes(q));
    if (!clients.length) {
      mount(list, html`<div class="empty">
        <div class="big-ico">${icon("users")}</div>
        <h3>Список клиентов пуст</h3>
        <p>Добавьте первого клиента: адрес его сайта Оптимайзера, логин и пароль.</p>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a></div>`);
      return;
    }
    if (!rows.length) { mount(list, html`<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте другой запрос</p></div>`); return; }
    mount(list, html`<div class="table-wrap"><table class="grid">
      <thead><tr><th>Клиент</th><th>Сайт</th><th>Логин</th><th>Статус</th><th>Последний сбор</th><th>Авто-сбор</th><th></th></tr></thead>
      <tbody>${rows.map((c, i) => html`<tr style="--i:${i}" data-id="${c.id}">
        <td><a class="client-cell" href="#/client/${c.id}">${avatar(c.name)}<span>
          <div class="name">${c.name}</div>${c.notes ? html`<div class="sub">${c.notes}</div>` : ""}</span></a></td>
        <td><a href="${c.base_url}" target="_blank" rel="noopener" class="chip">${hostOf(c.base_url)} ${icon("external")}</a></td>
        <td style="color:var(--text-2)">${c.login}</td>
        <td><span class="pill ${c.last_status}" title="${c.last_error || ""}">${c.last_status === "running" ? icon("refresh", "spin") : ""}${STATUS_TEXT[c.last_status] || c.last_status}</span>
          ${c.last_status === "error" && c.last_error ? html`<div class="sub" style="color:#fca5a5;font-size:12px;margin-top:4px;max-width:320px">${c.last_error}</div>` : ""}</td>
        <td style="color:var(--text-2)" title="${c.last_sync_at || ""}">${relTime(c.last_sync_at)}</td>
        <td><label class="switch" title="${c.enabled ? "Собирается по расписанию" : "Не собирается"}"><input type="checkbox" data-act="toggle" ${c.enabled ? "checked" : ""}><span></span></label></td>
        <td><div class="row-actions">
          <button class="icon-btn" data-act="sync" title="Собрать данные сейчас">${icon("refresh")}</button>
          <a class="icon-btn" href="#/clients/${c.id}/edit" title="Редактировать">${icon("edit")}</a>
          <button class="icon-btn danger" data-act="delete" title="Удалить">${icon("trash")}</button>
        </div></td>
      </tr>`)}</tbody></table></div>`);
  }
  draw();

  const input = root.querySelector("#q");
  input.addEventListener("input", debounce(() => { query = input.value; draw(); }, 120));

  async function reload() {
    clients = await api.clients();
    draw();
  }

  list.addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const id = +e.target.closest("tr").dataset.id;
    const c = clients.find((x) => x.id === id);
    try {
      const upd = await api.updateClient(id, { ...c, password: null, enabled: e.target.checked });
      Object.assign(c, upd);
      toast("success", `${c.name}: авто-сбор ${upd.enabled ? "включён" : "выключен"}`);
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast("error", "Не удалось сохранить", err.message);
    }
  });

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const tr = btn.closest("tr");
    const id = +tr.dataset.id;
    const c = clients.find((x) => x.id === id);

    if (btn.dataset.act === "delete") {
      const ok = await confirmModal({
        title: `Удалить «${c.name}»?`,
        text: "Клиент и все собранные по нему данные будут удалены. Это действие нельзя отменить.",
        confirmText: "Удалить",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteClient(id);
        tr.style.transition = "opacity .3s, transform .3s";
        tr.style.opacity = "0";
        tr.style.transform = "translateX(30px)";
        setTimeout(() => { clients = clients.filter((x) => x.id !== id); draw(); }, 280);
        toast("success", "Клиент удалён", c.name);
      } catch (err) {
        toast("error", "Не удалось удалить", err.message);
      }
    }

    if (btn.dataset.act === "sync") {
      await withBusy(btn, async () => {
        try {
          const res = await api.syncClient(id);
          res.ok ? toast("success", `${c.name}: данные обновлены`) : toast("error", `${c.name}: ошибка сбора`, res.error);
        } catch (err) {
          toast("error", "Ошибка", err.message);
        }
      });
      await reload();
    }
  });

  const onSync = () => reload();
  window.addEventListener("sync:progress", onSync);
  window.addEventListener("sync:done", onSync);
  return () => {
    window.removeEventListener("sync:progress", onSync);
    window.removeEventListener("sync:done", onSync);
  };
}
