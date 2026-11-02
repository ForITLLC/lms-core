import { queryOne } from "@/lib/db";

// Reads forit-HR hire dates from the shared `forit` DB (`hr.employees`).
// Used by lib/db/schedule.ts to anchor recurring-course cycles to the
// learner's actual start date rather than the day they first signed in.
//
// Join order: AAD object id (authoritative) → email fallback (catches HR rows
// where ad_object_id was never stamped). Returns null when neither matches or
// the row's start_date is unset — callers fall back to "today" so missing HR
// data never blocks a learner.

export async function getStartDateForUser(
  azureOid: string | null | undefined,
  email: string,
): Promise<Date | null> {
  const row = await queryOne<{ start_date: Date | null }>(
    `SELECT TOP 1 start_date FROM hr.employees
      WHERE (ad_object_id = @azureOid OR LOWER(email) = @email)
        AND last_day IS NULL
      ORDER BY CASE WHEN ad_object_id = @azureOid THEN 0 ELSE 1 END,
               id DESC`,
    { azureOid: azureOid ?? null, email: email.toLowerCase() },
  );
  return row?.start_date ?? null;
}
