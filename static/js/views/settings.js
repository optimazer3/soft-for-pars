// Settings: schedule, pacing of requests, history, sign-in.
import { api } from "../api.js";
import { fmtTime, html, icon, mount, plural, toast, withBusy } from "../ui.js";

export async function render(root) {
  const [s, me] = await Promise.all([api.settings(), api.me()]);
  let times = [...s.schedule_times];

  mount(root, html`
    <div class="page-head"><div>
      <h1 class="page-title">Настройки</h1>
      <div class="page-sub" id="next"></div>
    </div></div>
    <div class="form-layout">
      <div class="side-col">
        <div class="card">
          <h3 class="card-title">Расписание</h3>
          <div class="setting-row">
            <div><div class="t">Автоматическое обновление</div><div class="d">Данные всех включённых клиентов обновляются в указанное время</div></div>
            <label class="switch"><input type="checkbox" id="enabled" aria-label="Автоматическое обновление" ${s.schedule_enabled ? "checked" : ""}><span></span></label>
          </div>
          <div class="setting-row block">
            <div class="t">Время обновления</div>
            <div class="times" id="times"></div>
            <div class="add-time">
              <input type="time" id="new-time" value="12:00" aria-label="Новое время">
              <button class="btn btn-sm" id="add" type="button">${icon("plus")} Добавить</button>
            </div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">Бережный режим</h3>
          <div class="setting-row block">
            <div class="range-head"><span class="t">Одновременных запросов</span><b id="conc-v"></b></div>
            <div class="d">Сколько запросов к сайтам клиентов выполняется одновременно</div>
            <input type="range" class="range" id="conc" min="1" max="5" value="${s.concurrency}" aria-label="Одновременных запросов">
          </div>
          <div class="setting-row block">
            <div class="range-head"><span class="t">Пауза между запросами к одному сайту</span><b id="int-v"></b></div>
            <input type="range" class="range" id="int" min="300" max="3000" step="100" value="${s.request_interval_ms}" aria-label="Пауза между запросами">
          </div>
          <div class="setting-row block">
            <div class="range-head"><span class="t">Повторное обновление клиента — не чаще, чем раз в</span><b id="cd-v"></b></div>
            <input type="range" class="range" id="cd" min="0" max="60" step="5" value="${s.cooldown_min}" aria-label="Минимальный интервал обновления">
            <div class="note" id="estimate"></div>
          </div>
        </div>

        <div class="card">
          <h3 class="card-title">История</h3>
          <div class="setting-row block">
            <div class="range-head"><span class="t">Хранить данные прошлых дней</span><b id="ret-v"></b></div>
            <div class="d">Более старые данные удаляются автоматически, последние показатели клиента сохраняются всегда</div>
            <input type="range" class="range" id="ret" min="1" max="30" value="${s.snapshot_retention_days}" aria-label="Срок хранения">
          </div>
          <div class="card-actions"><button class="btn btn-primary" id="save" type="button">${icon("check")} Сохранить настройки</button></div>
        </div>
      </div>

      <form class="card" id="acc-form" autocomplete="off" novalidate>
        <h3>Вход</h3>
        <p class="hint">Логин и пароль для входа на этот сайт</p>
        <div class="field"><input id="acc-login" placeholder=" " value="${me.login}" autocomplete="username" spellcheck="false"><label for="acc-login">Логин</label></div>
        <div class="field"><input id="acc-new" type="password" placeholder=" " autocomplete="new-password"><label for="acc-new">Новый пароль</label>
          <div class="help">Не короче 8 символов</div></div>
        <div class="field"><input id="acc-cur" type="password" placeholder=" " autocomplete="current-password"><label for="acc-cur">Текущий пароль</label></div>
        <button class="btn" id="acc-save" type="submit">${icon("check")} Изменить</button>
      </form>
    </div>`);

  const $ = (q) => root.querySelector(q);
  const drawTimes = () => {
    mount($("#times"), times.length
      ? html`${times.map((t) => html`<span class="time-chip">${t}<button type="button" data-t="${t}" title="Убрать" aria-label="Убрать ${t}">${icon("x")}</button></span>`)}`
      : html`<span class="times-empty">Время не задано — автоматическое обновление не запускается</span>`);
  };
  const drawNext = (iso) => {
    if (!iso) { $("#next").textContent = "Автоматическое обновление выключено"; return; }
    const d = new Date(iso);
    const today = new Date().toDateString() === d.toDateString();
    $("#next").textContent = `Следующее обновление — ${today ? "сегодня" : d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })} в ${fmtTime(d)}`;
  };
  drawTimes();
  drawNext(s.schedule_enabled ? s.next_run : null);

  $("#times").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-t]");
    if (!b) return;
    times = times.filter((t) => t !== b.dataset.t);
    drawTimes();
  });
  $("#add").addEventListener("click", () => {
    const v = $("#new-time").value;
    if (!v) return;
    if (times.includes(v)) { toast("info", "Это время уже добавлено"); return; }
    times = [...times, v].sort();
    drawTimes();
  });

  const drawRanges = () => {
    const conc = +$("#conc").value;
    const interval = +$("#int").value / 1000;
    const cd = +$("#cd").value;
    $("#conc-v").textContent = conc;
    $("#int-v").textContent = `${interval.toLocaleString("ru-RU")} с`;
    $("#cd-v").textContent = cd ? `${cd} мин` : "без ограничения";
    $("#ret-v").textContent = plural(+$("#ret").value, "день", "дня", "дней");
    // ~11 requests per client with 3 branches; a site answers in about 2 s.
    const rate = Math.min(conc / Math.max(interval, 2), 1 / 0.3);
    const minutes = (n) => Math.max(1, Math.round((n * 11) / rate / 60));
    $("#estimate").innerHTML = String(html`Полное обновление займёт примерно <b>${minutes(50)} мин</b> для 50 клиентов и <b>${minutes(100)} мин</b> для 100.`);
  };
  ["#conc", "#int", "#cd", "#ret"].forEach((q) => $(q).addEventListener("input", drawRanges));
  drawRanges();

  $("#acc-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = {
      new_login: $("#acc-login").value.trim(),
      new_password: $("#acc-new").value,
      current_password: $("#acc-cur").value,
    };
    const bad = body.new_login.length < 3 ? ["#acc-login", "Логин — не короче 3 символов"]
      : body.new_password.length < 8 ? ["#acc-new", "Новый пароль — не короче 8 символов"]
      : !body.current_password ? ["#acc-cur", "Введите текущий пароль"] : null;
    if (bad) {
      const field = $(bad[0]).closest(".field");
      field.classList.remove("invalid");
      void field.offsetWidth;
      field.classList.add("invalid");
      $(bad[0]).focus();
      toast("error", bad[1]);
      return;
    }
    await withBusy($("#acc-save"), async () => {
      try {
        await api.changeCredentials(body);
        $("#acc-new").value = "";
        $("#acc-cur").value = "";
        localStorage.setItem("lastLogin", body.new_login);
        toast("success", "Данные для входа изменены");
      } catch (err) {
        toast("error", "Не удалось изменить", err.message);
      }
    });
  });
  $("#acc-form").addEventListener("input", (e) => e.target.closest(".field")?.classList.remove("invalid"));

  $("#save").addEventListener("click", (e) => withBusy(e.currentTarget, async () => {
    try {
      const res = await api.saveSettings({
        schedule_enabled: $("#enabled").checked,
        schedule_times: times,
        concurrency: +$("#conc").value,
        request_interval_ms: +$("#int").value,
        cooldown_min: +$("#cd").value,
        snapshot_retention_days: +$("#ret").value,
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
