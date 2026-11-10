// Full-screen sign-in form.
import { api } from "../api.js";
import { html, icon } from "../ui.js";

let open = false;

export function showLogin(onSuccess) {
  document.body.classList.remove("auth-pending");
  document.body.classList.add("auth-locked");
  if (open) return;
  open = true;

  const lastLogin = localStorage.getItem("lastLogin") || "admin";
  const root = document.getElementById("login-root");
  root.innerHTML = String(html`
    <div class="login-screen">
      <div class="login-orbs" aria-hidden="true"><i></i><i></i></div>
      <form class="login-card" id="login-form" autocomplete="on" novalidate>
        <div class="login-logo">
          <svg viewBox="0 0 32 32" aria-hidden="true"><circle cx="11" cy="16" r="5"/><circle cx="21" cy="16" r="5"/></svg>
        </div>
        <h1>Optimizer <b>Сводка</b></h1>
        <p class="login-sub">Войдите, чтобы продолжить</p>
        <div class="field"><input id="l-login" name="username" placeholder=" " autocomplete="username" value="${lastLogin}" spellcheck="false" required><label for="l-login">Логин</label></div>
        <div class="field">
          <input id="l-password" name="password" type="password" placeholder=" " autocomplete="current-password" required><label for="l-password">Пароль</label>
          <button type="button" class="icon-btn eye" id="l-eye" title="Показать пароль" aria-label="Показать пароль">${icon("eye")}</button>
        </div>
        <label class="check-row login-remember"><span class="switch"><input type="checkbox" id="l-remember" checked><span></span></span>Запомнить меня</label>
        <div class="login-error" id="l-error" role="alert"></div>
        <button class="btn btn-primary login-btn" id="l-submit" type="submit">
          <span class="lbl">Войти</span>${icon("arrowRight")}
        </button>
      </form>
    </div>`);

  const $ = (s) => root.querySelector(s);
  const form = $("#login-form");
  const pwd = $("#l-password");
  const err = $("#l-error");
  const btn = $("#l-submit");
  setTimeout(() => (lastLogin ? pwd : $("#l-login")).focus(), 300);

  $("#l-eye").addEventListener("click", () => {
    const show = pwd.type === "password";
    pwd.type = show ? "text" : "password";
    $("#l-eye").innerHTML = String(icon(show ? "eyeOff" : "eye"));
  });

  const showError = (text) => {
    err.textContent = text;
    err.classList.add("show");
    form.classList.remove("shake");
    void form.offsetWidth;
    form.classList.add("shake");
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (btn.disabled) return;
    err.classList.remove("show");
    const login = $("#l-login").value.trim();
    if (!login || !pwd.value) { showError("Введите логин и пароль"); return; }
    btn.disabled = true;
    btn.classList.add("loading");
    try {
      const res = await api.login({ login, password: pwd.value, remember: $("#l-remember").checked });
      localStorage.setItem("lastLogin", res.login);
      form.classList.add("success");
      setTimeout(() => {
        root.querySelector(".login-screen")?.classList.add("out");
        setTimeout(() => {
          root.innerHTML = "";
          open = false;
          onSuccess();
        }, 300);
      }, 250);
    } catch (ex) {
      btn.disabled = false;
      btn.classList.remove("loading");
      showError(ex.message);
      pwd.select();
    }
  });
}
