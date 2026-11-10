// Clients list: status, enable/disable, refresh, edit, delete.
import { api } from "../api.js";
import {
  avatar, confirmModal, debounce, hostOf, html, icon, mount, relSpan, STATUS_TEXT, syncErrorToast, toast, withBusy,
} from "../ui.js";

export async function render(root) {
  let clients = await api.clients();
  let query = "";

  mount(root, html`
    <div class="page-head">
      <div>
        <h1 class="page-title">Клиенты</h1>
        <div class="page-sub">Сайты Оптимайзера, с которых собираются показатели</div>
      </div>
      <div class="toolbar">
        <label class="search">${icon("search")}<input id="q" placeholder="Поиск клиента" aria-label="Поиск клиента"></label>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a>
      </div>
    </div>
    <div id="list"></div>`);
  const list = root.querySelector("#list");

  function statusCell(c) {
    return html`<span class="pill ${c.last_status}">${c.last_status === "running" ? icon("refresh", "spin") : ""}${STATUS_TEXT[c.last_status] || c.last_status}</span>
      ${c.last_status === "error" && c.last_error ? html`<div class="cell-error">${c.last_error}</div>` : ""}`;
  }

  function draw() {
    const q = query.trim().toLowerCase();
    const rows = clients.filter((c) => !q || c.name.toLowerCase().includes(q) || c.base_url.toLowerCase().includes(q) || c.login.toLowerCase().includes(q));
    if (!clients.length) {
      mount(list, html`<div class="empty">
        <div class="big-ico">${icon("users")}</div>
        <h3>Список клиентов пуст</h3>
        <p>Добавьте первого клиента: адрес его сайта Оптимайзера, логин и пароль.</p>
        <a class="btn btn-primary" href="#/clients/new">${icon("plus")} Добавить клиента</a></div>`);
      return;
    }
    if (!rows.length) { mount(list, html`<div class="empty"><h3>Ничего не найдено</h3><p>Попробуйте изменить запрос</p></div>`); return; }
    mount(list, html`<div class="table-wrap"><table class="grid">
      <thead><tr><th>Клиент</th><th>Сайт</th><th>Логин</th><th>Состояние</th><th>Последний запуск</th><th>Автообновление</th><th></th></tr></thead>
      <tbody>${rows.map((c, i) => html`<tr style="--i:${i}" data-id="${c.id}">
        <td><a class="client-cell" href="#/client/${c.id}">${avatar(c.name)}<span>
          <div class="name">${c.name}</div>${c.notes ? html`<div class="sub">${c.notes}</div>` : ""}</span></a></td>
        <td><a href="${c.base_url}" target="_blank" rel="noopener" class="chip">${hostOf(c.base_url)} ${icon("external")}</a></td>
        <td class="cell-muted">${c.login}</td>
        <td>${statusCell(c)}</td>
        <td class="cell-muted">${c.last_sync_at ? relSpan(c.last_sync_at) : "—"}</td>
        <td><label class="switch" title="${c.enabled ? "Обновляется по расписанию" : "Не обновляется по расписанию"}"><input type="checkbox" data-act="toggle" aria-label="Автообновление" ${c.enabled ? "checked" : ""}><span></span></label></td>
        <td><div class="row-actions">
          <button class="icon-btn" data-act="sync" title="Обновить сейчас" aria-label="Обновить сейчас" ${c.last_status === "running" ? "disabled" : ""}>${icon("refresh", c.last_status === "running" ? "spin" : "")}</button>
          <a class="icon-btn" href="#/clients/${c.id}/edit" title="Редактировать" aria-label="Редактировать">${icon("edit")}</a>
          <button class="icon-btn danger" data-act="delete" title="Удалить" aria-label="Удалить">${icon("trash")}</button>
        </div></td>
      </tr>`)}</tbody></table></div>`);
  }
  draw();

  const input = root.querySelector("#q");
  input.addEventListener("input", debounce(() => { query = input.value; draw(); }, 120));

  async function reload() {
    try {
      const fresh = await api.clients();
      if (!root.isConnected) return;
      clients = fresh;
      draw();
    } catch { /* shown elsewhere */ }
  }

  list.addEventListener("change", async (e) => {
    if (e.target.dataset.act !== "toggle") return;
    const box = e.target;
    const id = +box.closest("tr").dataset.id;
    const c = clients.find((x) => x.id === id);
    box.disabled = true;
    try {
      const upd = await api.updateClient(id, {
        name: c.name, base_url: c.base_url, login: c.login, notes: c.notes, password: null, enabled: box.checked,
      });
      Object.assign(c, upd);
      box.closest(".switch").title = upd.enabled ? "Обновляется по расписанию" : "Не обновляется по расписанию";
      toast("success", upd.enabled ? "Автообновление включено" : "Автообновление выключено", c.name);
    } catch (err) {
      box.checked = !box.checked;
      toast("error", "Не удалось сохранить", err.message);
    } finally {
      box.disabled = false;
    }
  });

  list.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn || btn.disabled) return;
    const tr = btn.closest("tr");
    const id = +tr.dataset.id;
    const c = clients.find((x) => x.id === id);

    if (btn.dataset.act === "delete") {
      const ok = await confirmModal({
        title: `Удалить «${c.name}»?`,
        text: "Клиент и все его показатели будут удалены. Это действие нельзя отменить.",
        confirmText: "Удалить",
        danger: true,
      });
      if (!ok) return;
      try {
        await api.deleteClient(id);
        tr.style.transition = "opacity .2s, transform .2s";
        tr.style.opacity = "0";
        tr.style.transform = "translateX(16px)";
        setTimeout(() => { clients = clients.filter((x) => x.id !== id); draw(); }, 200);
        toast("success", "Клиент удалён", c.name);
      } catch (err) {
        toast("error", "Не удалось удалить", err.message);
      }
    }

    if (btn.dataset.act === "sync") {
      await withBusy(btn, async () => {
        try {
          const res = await api.syncClient(id);
          res.ok ? toast("success", "Данные обновлены", c.name) : toast("error", `${c.name}: не удалось обновить`, res.error);
        } catch (err) {
          syncErrorToast(err);
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
