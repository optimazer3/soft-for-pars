// Catalog of Optimizer metrics: labels (as on the Optimizer site), groups and formats.
// Metrics that are not listed here still show up in the "Другое" group with their API name.

export const METRICS = {
  // Воронка
  windows_count: ["Окна", "count"],
  traffic: ["Трафик", "count"],
  selections_count: ["Подборы", "count"],
  prescriptions: ["Рецепты", "count"],
  lost_count: ["К-во ушедших", "count"],
  own_orders_count: ["Заказы (наши)", "count"],
  foreign_orders_count: ["Заказы (чужие)", "count"],
  total_orders: ["Итого заказов", "count"],
  // Конверсии
  loading_percentage: ["% загрузки", "percent"],
  selection_to_prescription: ["% подбор → рецепт", "percent"],
  prescription_to_order: ["% рецепт → заказ (наш)", "percent"],
  selection_to_own_order: ["% подбор → заказ (наш)", "percent"],
  lost_percentage: ["% ушедших", "percent"],
  foreign_orders_percentage: ["% чужих заказов", "percent"],
  traffic_to_selection_conversion: ["% трафик → подбор", "percent"],
  traffic_to_order_conversion: ["% трафик → заказ", "percent"],
  // Средние чеки
  own_orders_avg_check: ["Ср. чек (наш)", "money"],
  foreign_orders_avg_check: ["Ср. чек (чужой)", "money"],
  average_check: ["Итого ср. чек", "money"],
  own_orders_avg_lenses: ["Ср. чек линз (наш)", "money"],
  own_orders_avg_frames: ["Ср. чек оправы (наш)", "money"],
  own_orders_avg_service: ["Ср. чек мастера (наш)", "money"],
  foreign_orders_avg_lenses: ["Ср. чек линз (чужой)", "money"],
  foreign_orders_avg_frames: ["Ср. чек оправы (чужой)", "money"],
  foreign_orders_avg_service: ["Ср. чек мастера (чужой)", "money"],
  total_avg_lenses: ["Итого ср. чек линз", "money"],
  total_avg_frames: ["Итого ср. чек оправ", "money"],
  average_check_service: ["Итого ср. чек мастера", "money"],
  // Суммы
  sales_amount: ["Итого сумма заказов", "money"],
  own_orders_total_amount: ["Сумма заказов (наши)", "money"],
  own_orders_total_service: ["Сумма работ мастера (наши)", "money"],
  total_lenses_amount: ["Итого сумма линз", "money"],
  total_frames_amount: ["Итого сумма оправ", "money"],
  total_service_amount: ["Итого сумма за работы мастера", "money"],
  // ВТЛ
  vtl_recommendations_count: ["К-во рекомендаций ВТЛ", "count"],
  vtl_recommendations_percentage: ["% рекомендаций ВТЛ", "percent"],
  vtl_orders_count: ["К-во заказов ВТЛ", "count"],
  vtl_conversion: ["% продаж ВТЛ", "percent"],
  vtl_average_check: ["Ср. чек заказа ВТЛ", "money"],
  vtl_avg_lenses: ["Ср. чек линз ВТЛ", "money"],
  vtl_avg_service: ["Ср. чек мастера ВТЛ", "money"],
  vtl_total_amount: ["Сумма выручки по ВТЛ", "money"],
  // Прочие продажи
  other_total_volume: ["Общий объём продаж", "money"],
  other_mkl_count: ["МКЛ: кол-во", "count"],
  other_mkl_amount: ["МКЛ: сумма", "money"],
  other_mkl_avg_check: ["МКЛ: ср. чек", "money"],
  other_mkl_avg_purchases_per_client: ["МКЛ: ср. к-во покупок/год", "count"],
  other_mkl_avg_amount_per_client: ["МКЛ: ср. сумма покупок/год", "money"],
  other_okl_count: ["ОКЛ: кол-во", "count"],
  other_okl_amount: ["ОКЛ: сумма", "money"],
  other_okl_avg_check: ["ОКЛ: ср. чек", "money"],
  other_sun_count: ["Солнцезащ. очки: кол-во", "count"],
  other_sun_amount: ["Солнцезащ. очки: сумма", "money"],
  other_sun_avg_check: ["Солнцезащ. очки: ср. чек", "money"],
  other_repair_count: ["Ремонт: кол-во", "count"],
  other_repair_amount: ["Ремонт: сумма", "money"],
  other_repair_avg_check: ["Ремонт: ср. чек", "money"],
  other_acc_count: ["Аксессуары: кол-во", "count"],
  other_acc_amount: ["Аксессуары: сумма", "money"],
  other_acc_avg_check: ["Аксессуары: ср. чек", "money"],
  other_med_count: ["Мед. услуги: кол-во", "count"],
  other_med_amount: ["Мед. услуги: сумма", "money"],
  other_med_avg_check: ["Мед. услуги: ср. чек", "money"],
  other_prochee_count: ["Прочее: кол-во", "count"],
  other_prochee_amount: ["Прочее: сумма", "money"],
  other_prochee_avg_check: ["Прочее: ср. чек", "money"],
};

export const GROUPS = [
  ["Воронка продаж", ["windows_count", "traffic", "selections_count", "prescriptions", "lost_count", "own_orders_count", "foreign_orders_count", "total_orders"]],
  ["Конверсии", ["loading_percentage", "selection_to_prescription", "prescription_to_order", "selection_to_own_order", "lost_percentage", "foreign_orders_percentage", "traffic_to_selection_conversion", "traffic_to_order_conversion"]],
  ["Суммы", ["sales_amount", "own_orders_total_amount", "own_orders_total_service", "total_lenses_amount", "total_frames_amount", "total_service_amount"]],
  ["Средние чеки", ["average_check", "own_orders_avg_check", "foreign_orders_avg_check", "own_orders_avg_lenses", "own_orders_avg_frames", "own_orders_avg_service", "foreign_orders_avg_lenses", "foreign_orders_avg_frames", "foreign_orders_avg_service", "total_avg_lenses", "total_avg_frames", "average_check_service"]],
  ["ВТЛ", ["vtl_recommendations_count", "vtl_recommendations_percentage", "vtl_orders_count", "vtl_conversion", "vtl_average_check", "vtl_avg_lenses", "vtl_avg_service", "vtl_total_amount"]],
  ["Прочие продажи", Object.keys(METRICS).filter((k) => k.startsWith("other_"))],
];

export function metricLabel(key) {
  return METRICS[key]?.[0] ?? key;
}

export function metricKind(key) {
  if (METRICS[key]) return METRICS[key][1];
  if (/percentage|conversion/.test(key)) return "percent";
  if (/amount|avg|check/.test(key)) return "money";
  return "count";
}

const nf0 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

export function formatValue(value, kind) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (kind === "percent") return `${nf1.format(value)}%`;
  if (kind === "money") return `${nf0.format(value)} ₽`;
  return Number.isInteger(value) ? nf0.format(value) : nf1.format(value);
}

/** Status of a metric for colouring. No plan -> neutral. */
export function metricStatus(m) {
  if (!m || !m.plan) return "neutral";
  return ["excellent", "good", "poor"].includes(m.status) ? m.status : "neutral";
}
