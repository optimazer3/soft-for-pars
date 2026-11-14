import { api } from "./api.js";
import { fmtDay, formModal, html } from "./ui.js";

const groups = [
  ["Продажи", [
    ["sales_execution", "Выполнение плана, %", true],
    ["sales_forecast", "Прогноз, %", true],
    ["sales_fact", "Факт продаж, ₽", true],
    ["sales_plan", "План продаж, ₽", true],
    ["orders_amount", "Сумма заказов, ₽", true],
    ["orders_plan", "План по сумме заказов, ₽", true],
    ["vtl_count", "Заказы ВТЛ"],
    ["vtl_plan", "План заказов ВТЛ"],
  ]],
  ["Активность и задачи", [
    ["activity_hours", "Активность за эту неделю, ч", true],
    ["previous_activity_hours", "Активность за прошлую неделю, ч", true],
    ["tasks_done", "Выполнено за эту неделю"],
    ["tasks_total", "Всего за эту неделю"],
    ["previous_tasks_done", "Выполнено за прошлую неделю"],
    ["previous_tasks_total", "Всего за прошлую неделю"],
    ["tasks_created", "Поставлено задач за день"],
    ["analysis_tasks", "Задачи из анализа филиалов"],
  ]],
  ["Сигналы и аудиобейджи", [
    ["signals_done", "Разобрано сигналов"],
    ["signals_total", "Всего сигналов"],
    ["badges_issued", "Выдано аудиобейджей"],
    ["badges_total", "Всего аудиобейджей"],
  ]],
];

export function editMetrics(client, snapshot, day) {
  const saved = snapshot?.metric_overrides || {};
  const imported = snapshot?.metric_values || {};
  const autoValue = (name) => {
    if (name.startsWith("signals_") && snapshot?.extras?.signals?.day !== day) return null;
    if (name === "tasks_created" || name === "analysis_tasks") {
      if (snapshot?.day !== day) return null;
    }
    return imported[name];
  };
  return formModal({
    title: client.name,
    text: `Показатели на ${fmtDay(day)}. Чтобы вернуть значение из Оптимайзера, очистите поле.`,
    body: html`<div class="metric-fields">${groups.map(([title, fields]) => html`
      <fieldset>
        <legend>${title}</legend>
        <div class="metric-group">${fields.map(([name, label, decimal]) => html`
          <label>${label}
            <input type="number" name="${name}" min="0" step="${decimal ? "any" : "1"}"
              value="${saved[name] ?? ""}" placeholder="${autoValue(name) ?? "—"}">
          </label>`)}</div>
      </fieldset>`)}</div>`,
    onSubmit: async (form) => {
      if (!form.reportValidity()) throw new Error("Проверьте значения в выделенных полях");
      const changes = {};
      for (const [name, text] of new FormData(form)) {
        const value = text === "" ? null : Number(text);
        if (value !== (saved[name] ?? null)) changes[name] = value;
      }
      if (Object.keys(changes).length === 0) return { changed: false };
      await api.updateMetrics(client.id, day, changes);
      return { changed: true };
    },
  });
}
