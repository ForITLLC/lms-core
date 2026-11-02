import { query } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { SEAT_HELD } from "@/lib/db/entitlements";

// Usage of one marketplace entitlement (docs/contracts/marketplace-connection.md §5). Every count
// is of distinct seat holders: learners with an active assignment carrying this EntitlementId.
// Every learner-side table is read under the entitlement's own buyer TenantId and CourseId. Only
// counts and month keys leave the SELECT: no learner id, name, email or per-person date.

export interface EntitlementUsage {
  seats: number;
  assigned: number;
  started: number;
  completed: number;
  dueForRenewalByMonth: Record<string, number>;
}

interface UsageRow {
  Seats: number;
  Assigned: number;
  Started: number;
  Completed: number;
  RenewalMonth: string | null;
  RenewalCount: number | null;
}

// A holder is completed when this cycle is finished or, while a renewal cycle is open (which
// clears Enrollment.CompletedAt), an earlier cycle earned a certificate. Renewal months come from
// each holder's newest non-revoked certificate, the one every standing reader takes. One row per
// renewal month, or one row with no month; no row for an unknown entitlement.
const USAGE = `WITH holder AS (
       SELECT a.LearnerId,
              CASE WHEN enr.EnrollmentId IS NULL THEN 0 ELSE 1 END AS Started,
              CASE WHEN ${lastCompletedAt("enr")} IS NULL THEN 0 ELSE 1 END AS Completed,
              latest.ExpiresAt
         FROM lms.Entitlement e
         JOIN lms.CourseAssignment a ON ${SEAT_HELD} AND a.CourseId = e.CourseId
         LEFT JOIN lms.Enrollment enr
           ON enr.TenantId = e.TenantId AND enr.LearnerId = a.LearnerId AND enr.CourseId = e.CourseId
        OUTER APPLY (
          SELECT TOP 1 cert.ExpiresAt
            FROM lms.Certificate cert
           WHERE cert.TenantId = e.TenantId AND cert.LearnerId = a.LearnerId
             AND cert.CourseId = e.CourseId AND cert.RevokedAt IS NULL
           ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC, cert.CertificateId DESC
        ) latest
        WHERE e.EntitlementId = @entitlementId
     )
     SELECT e.Seats,
            (SELECT COUNT(DISTINCT h.LearnerId) FROM holder h) AS Assigned,
            (SELECT COUNT(DISTINCT h.LearnerId) FROM holder h WHERE h.Started = 1) AS Started,
            (SELECT COUNT(DISTINCT h.LearnerId) FROM holder h WHERE h.Completed = 1) AS Completed,
            due.RenewalMonth, due.RenewalCount
       FROM lms.Entitlement e
       LEFT JOIN (
         SELECT CONVERT(char(7), h.ExpiresAt, 23) AS RenewalMonth, COUNT(DISTINCT h.LearnerId) AS RenewalCount
           FROM holder h
          WHERE h.ExpiresAt >= CONVERT(date, @monthStart, 23)
          GROUP BY CONVERT(char(7), h.ExpiresAt, 23)
       ) due ON 1 = 1
      WHERE e.EntitlementId = @entitlementId
      ORDER BY due.RenewalMonth`;

// `at` is the instant the caller answers as of; renewals count from the first day of its UTC month.
export async function getEntitlementUsage(entitlementId: string, at: Date = new Date()): Promise<EntitlementUsage | null> {
  const monthStart = `${at.toISOString().slice(0, 7)}-01`;
  const rows = await query<UsageRow>(USAGE, { entitlementId, monthStart });
  const first = rows[0];
  if (!first) return null;
  const dueForRenewalByMonth: Record<string, number> = {};
  for (const row of rows) {
    if (row.RenewalMonth !== null && row.RenewalCount !== null) dueForRenewalByMonth[row.RenewalMonth] = row.RenewalCount;
  }
  return {
    seats: first.Seats,
    assigned: first.Assigned,
    started: first.Started,
    completed: first.Completed,
    dueForRenewalByMonth,
  };
}
