// Recurrence math for LMS courses. Per the 2026-05-17 design:
//   annual    -> Jan 31 of next year after issuance (30-day grace into Q1).
//   recurring -> issue/start + RecurrenceMonths.
//   null      -> evergreen, no expiry / no next-due.
//
// All dates UTC. The schedule is computed at read time — there is no
// per-learner Assignment materialization (YAGNI: a single query at dashboard
// load time covers every surface that needs "next due / overdue" today).

export type ScheduleKind = "annual" | "recurring" | null;

const ANNUAL_DUE_MONTH = 0; // January (0-indexed)
const ANNUAL_DUE_DAY = 31;
const NEW_HIRE_GRACE_DAYS = 30;

function addMonthsUtc(d: Date, months: number): Date {
  const out = new Date(d.getTime());
  out.setUTCMonth(out.getUTCMonth() + months);
  return out;
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

function nextAnnualDueOnOrAfter(from: Date): Date {
  const yr = from.getUTCFullYear();
  const candidate = new Date(Date.UTC(yr, ANNUAL_DUE_MONTH, ANNUAL_DUE_DAY));
  if (candidate.getTime() >= from.getTime()) return candidate;
  return new Date(Date.UTC(yr + 1, ANNUAL_DUE_MONTH, ANNUAL_DUE_DAY));
}

// Next deadline for a learner who has (or hasn't) earned the cert yet.
// `now` is injectable so tests can pin a date.
export function nextDueForLearner(
  kind: ScheduleKind,
  recurrenceMonths: number | null,
  startDate: Date | null,
  lastIssuedAt: Date | null,
  now: Date = new Date(),
): Date | null {
  if (!kind) return null;

  if (kind === "annual") {
    if (lastIssuedAt) {
      const yr = lastIssuedAt.getUTCFullYear() + 1;
      return new Date(Date.UTC(yr, ANNUAL_DUE_MONTH, ANNUAL_DUE_DAY));
    }
    const graceFromStart = addDaysUtc(
      startDate ?? now,
      NEW_HIRE_GRACE_DAYS,
    );
    const upcomingJan31 = nextAnnualDueOnOrAfter(now);
    return graceFromStart.getTime() > upcomingJan31.getTime()
      ? graceFromStart
      : upcomingJan31;
  }

  if (kind === "recurring" && recurrenceMonths && recurrenceMonths > 0) {
    const anchor = lastIssuedAt ?? startDate ?? now;
    return addMonthsUtc(anchor, recurrenceMonths);
  }

  return null;
}

// Cert expiry on issuance. Mirrors nextDueForLearner with issuedAt=now and no
// startDate (the cert itself is the new anchor).
export function computeCertExpiresAt(
  kind: ScheduleKind,
  recurrenceMonths: number | null,
  issuedAt: Date = new Date(),
): Date | null {
  if (!kind) return null;
  if (kind === "annual") {
    return new Date(
      Date.UTC(issuedAt.getUTCFullYear() + 1, ANNUAL_DUE_MONTH, ANNUAL_DUE_DAY),
    );
  }
  if (kind === "recurring" && recurrenceMonths && recurrenceMonths > 0) {
    return addMonthsUtc(issuedAt, recurrenceMonths);
  }
  return null;
}
