// Shared by the dashboard and client pages for the duration of the visit.
let selectedDay = "";

export function reportDay() {
  return selectedDay;
}

export function selectReportDay(day) {
  selectedDay = day;
}
