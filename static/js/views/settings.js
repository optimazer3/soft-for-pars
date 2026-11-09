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
          <div class="t" style="margin-bottom:2px">Бережный режим</div>
          <div class="d">Ограничения, чтобы сбор не создавал заметной нагрузки на сайты Оптимайзера.
            Все клиенты живут на одном домене optmzr.ru, поэтому лимиты общие для всех.</div>
        </div>
        <div class="setting-row" style="display:block">
          <div class="range-head"><span class="t">Одновременных запросов к Оптимайзеру</span><b id="conc-v">${s.concurrency}</b></div>
          <div class="d" style="margin-bottom:10px">Сколько запросов может идти одновременно на весь домен. К одному сайту — всегда по одному.</div>
          <input type="range" class="range" id="conc" min="1" max="5" value="${s.concurrency}">
        </div>
        <div class="setting-row" style="display:block">
          <div class="range-head"><span class="t">Пауза между запросами к одному сайту</span><b id="int-v"></b></div>
          <div class="d" style="margin-bottom:10px">Плюс общий лимит: не больше ~3 запросов в секунду на весь домен.</div>
          <input type="range" class="range" id="int" min="300" max="3000" step="100" value="${s.request_interval_ms}">
        </div>
        <div class="setting-row" style="display:block">
          <div class="range-head"><span class="t">Не обновлять клиента чаще, чем раз в</span><b id="cd-v"></b></div>
          <div class="d" style="margin-bottom:10px">Повторные нажатия «Обновить» в этот период не отправляют запросы на сайт.</div>
          <input type="range" class="range" id="cd" min="0" max="60" step="5" value="${s.cooldown_min}">
          <div class="protect-summary" id="estimate"></div>
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
          <li>Если сайт отвечает ошибками или просит притормозить, программа делает паузу и повторяет позже. Если сервер не справляется у нескольких клиентов подряд — сбор по этому домену останавливается до следующего запуска.</li>
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
  const drawProtect = () => {
    const conc = +$("#conc").value;
    const interval = +$("#int").value / 1000;
    const cd = +$("#cd").value;
    $("#conc-v").textContent = conc;
    $("#int-v").textContent = `${interval.toLocaleString("ru-RU")} с`;
    $("#cd-v").textContent = cd ? `${cd} мин` : "без ограничения";
    // ~11 requests per client (3 salons); the Optimizer answers in ~2 s per request.
    const RESP = 2;
    const perClient = 11 * Math.max(interval, RESP);
    const rate = Math.min(conc / Math.max(interval, RESP), 1 / 0.3);
    const minutes = (n) => Math.max(1, Math.round((n * 11) / rate / 60));
    $("#estimate").innerHTML = String(html`Один клиент (3 салона, ~11 запросов) — около <b>${Math.round(perClient)} с</b>.
      Нагрузка на домен — не больше <b>${rate.toLocaleString("ru-RU", { maximumFractionDigits: 1 })} запроса/с</b>.
      Сбор 50 клиентов займёт ~<b>${minutes(50)} мин</b>, 100 клиентов — ~<b>${minutes(100)} мин</b>.`);
  };
  ["#conc", "#int", "#cd"].forEach((q) => $(q).addEventListener("input", drawProtect));
  drawProtect();

  $("#save").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const res = await api.saveSettings({
        schedule_enabled: $("#enabled").checked,
        schedule_times: times,
        concurrency: +$("#conc").value,
        request_interval_ms: +$("#int").value,
        cooldown_min: +$("#cd").value,
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
