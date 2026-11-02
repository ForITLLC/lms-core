export interface StreakStats {
  currentStreak: number;
  longestStreak: number;
  lastCompletedLocalDate: string | null;
  freezesAvailable: number;
}

export interface StreakResult extends StreakStats {
  freezesConsumed: number;
  changed: boolean;
}

export const FREEZE_CAP = 2;
export const FREEZE_EVERY_DAYS = 7;

function utcDay(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

function toIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, n: number): string {
  const d = utcDay(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

export function isWorkday(iso: string): boolean {
  const dow = utcDay(iso).getUTCDay();
  return dow >= 1 && dow <= 5;
}

/** Workdays strictly between `last` and `today` that went uncompleted. */
export function missedWorkdaysBetween(last: string | null, today: string): number {
  if (!last) return 0;
  let missed = 0;
  for (let cur = addDays(last, 1); cur < today; cur = addDays(cur, 1)) {
    if (isWorkday(cur)) missed += 1;
  }
  return missed;
}

export function advanceStreak(stats: StreakStats, today: string): StreakResult {
  const last = stats.lastCompletedLocalDate;
  if (last !== null && last >= today) return { ...stats, freezesConsumed: 0, changed: false };

  const missed = missedWorkdaysBetween(last, today);
  let freezes = stats.freezesAvailable;
  let consumed = 0;
  let current: number;
  if (missed === 0) {
    current = stats.currentStreak + 1;
  } else if (missed <= freezes) {
    consumed = missed;
    freezes -= missed;
    current = stats.currentStreak + 1;
  } else {
    current = 1;
  }
  if (current % FREEZE_EVERY_DAYS === 0) freezes = Math.min(FREEZE_CAP, freezes + 1);

  return {
    currentStreak: current,
    longestStreak: Math.max(stats.longestStreak, current),
    lastCompletedLocalDate: today,
    freezesAvailable: freezes,
    freezesConsumed: consumed,
    changed: true,
  };
}
