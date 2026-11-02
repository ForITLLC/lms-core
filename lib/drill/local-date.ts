export const DEFAULT_TIME_ZONE = "America/Vancouver";

export function resolveTimeZone(tz: string | null | undefined): string {
  if (!tz) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/** Calendar date (YYYY-MM-DD) for `now` as seen in `timeZone`. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
