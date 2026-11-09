// Settings: collection schedule and parallelism.
import { api } from "../api.js";
import { fmtTime, html, icon, mount, toast, withBusy } from "../ui.js";

export async function render(root) {
  const s = await api.settings();
  let times = [...s.schedule_times];

  mount(root, html`
    <div class="page-head"><div>
      <h1 class="page-title">Настройки</h1>
      <div class="page-sub">Расписание автоматического сбора данных</div>
    </div></div>
    <div class="form-layout">
      <div class="card">
        <div class="setting-row">
          <div><div class="t">Автоматический сбор</div><div class="d">Собирать данные по всем включённым клиентам в указанное время</div></div>
          <label class="switch"><input type="checkbox" id="enabled" ${s.schedule_enabled ? "checked" : ""}><span></span></label>
        </div>
        <div class="setting-row" style="display:block">
          <div class="t">Время сбора</div>
          <div class="d">По времени этого компьютера. Если ноутбук был выключен, сбор запустится сразу после старта программы.</div>
          <div class="times" id="times"></div>
          <div class="add-time">
            <input type="time" id="new-time" value="12:00">
            <button class="btn btn-sm" id="add">${icon("plus")} Добавить время</button>
          </div>
        </div>
        <div class="setting-row" style="display:block">
          <div style="display:flex;justify-content:space-between"><span class="t">Одновременных подключений</span><b id="conc-v">${s.concurrency}</b></div>
          <div class="d" style="margin-bottom:10px">Сколько клиентов собирать параллельно. Больше — быстрее, но выше нагрузка на сайты.</div>
          <input type="range" class="range" id="conc" min="1" max="20" value="${s.concurrency}">
        </div>
        <div class="form-actions" style="margin-top:18px">
          <button class="btn btn-primary" id="save">${icon("check")} Сохранить</button>
        </div>
      </div>
      <div class="card tips">
        <h3>Как это работает</h3>
        <ol>
          <li>Программа должна быть запущена (окно <code>start.bat</code> открыто) — тогда сбор идёт по расписанию.</li>
          <li>Кнопка «Обновить всех» вверху запускает сбор вне расписания.</li>
          <li>Каждый сбор сохраняется: за день хранится последний снимок по каждому клиенту.</li>
        </ol>
        <p id="next" style="margin-top:14px"></p>
      </div>
    </div>`);

  const $ = (q) => root.querySelector(q);
  const drawTimes = () => {
    mount($("#times"), times.length
      ? html`${times.map((t) => html`<span class="time-chip">${icon("clock")} ${t}<button data-t="${t}" title="Убрать">${icon("x")}</button></span>`)}`
      : html`<span style="color:var(--muted)">Время не задано — автоматический сбор не будет запускаться</span>`);
  };
  const drawNext = (iso) => {
    $("#next").innerHTML = iso
      ? String(html`Следующий сбор: <b>${new Date(iso).toLocaleDateString("ru-RU")} в ${fmtTime(new Date(iso))}</b>`)
      : "Автоматический сбор выключен";
  };
  drawTimes();
  drawNext(s.next_run);

  $("#times").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (!b) return;
    times = times.filter((t) => t !== b.dataset.t);
    drawTimes();
  });
  $("#add").addEventListener("click", () => {
    const v = $("#new-time").value;
    if (!v) return;
    if (times.includes(v)) { toast("info", "Это время уже есть"); return; }
    times = [...times, v].sort();
    drawTimes();
  });
  $("#conc").addEventListener("input", (e) => { $("#conc-v").textContent = e.target.value; });

  $("#save").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const res = await api.saveSettings({
        schedule_enabled: $("#enabled").checked,
        schedule_times: times,
        concurrency: +$("#conc").value,
      });
      times = res.schedule_times;
      drawTimes();
      drawNext(res.schedule_enabled ? res.next_run : null);
      window.dispatchEvent(new Event("settings:changed"));
      toast("success", "Настройки сохранены");
    } catch (err) {
      toast("error", "Не удалось сохранить", err.message);
    }
  }));
}
