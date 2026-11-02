// A due date is a calendar day stored as midnight UTC: AssignmentEditor sends
// new Date("YYYY-MM-DD"), and the annual deadline is a DATEFROMPARTS. Shown in
// the browser's zone it is the day before anywhere west of UTC, so it is shown
// as its UTC date, as the digests (toISOString().slice(0, 10)) and the iPhone
// app (TrainingItem.dueDay) show it.
export function formatDueDay(iso: string, locale?: string): string {
  return new Date(iso).toLocaleDateString(locale, { timeZone: "UTC" });
}
