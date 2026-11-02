import { query } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";

// Tenant-scoped learner directory backing GET /api/v1/learners. Read-only and
// filtered by the TenantId resolved from the caller's API key — never from
// request input.

export interface LearnerDirectoryRow {
  learnerId: string;
  displayName: string;
  email: string;
  status: string;
  enrollments: number;
  completions: number;
  lastSeenAt: Date | null;
}

// Every learner in the tenant. last-seen is derived from the most recent
// lms.Progress row, or lms.ProgressHistory row once a renewal archived it
// (lms.Learner has no LastSeenAt column), so it reflects real training
// activity rather than a sign-in timestamp.
export async function listLearnersForTenant(
  tenantId: string,
): Promise<LearnerDirectoryRow[]> {
  const rows = await query<{
    LearnerId: string;
    DisplayName: string;
    Email: string;
    Status: string;
    Enrollments: number;
    Completions: number;
    LastSeenAt: Date | null;
  }>(
    `SELECT CONVERT(varchar(64), l.LearnerId) AS LearnerId,
            l.DisplayName, l.Email, l.Status,
            ISNULL(en.Enrollments, 0) AS Enrollments,
            ISNULL(en.Completions, 0) AS Completions,
            pr.LastSeenAt
       FROM lms.Learner l
       OUTER APPLY (
         SELECT COUNT(*) AS Enrollments,
                SUM(done.Completed) AS Completions
           FROM lms.Enrollment e
           -- SQL Server cannot aggregate over a subquery (Msg 130): flag each row first.
           CROSS APPLY (SELECT CASE WHEN ${lastCompletedAt("e")} IS NOT NULL THEN 1 ELSE 0 END AS Completed) done
          WHERE e.LearnerId = l.LearnerId AND e.TenantId = @tenantId
       ) en
       OUTER APPLY (
         SELECT MAX(seen.CompletedAt) AS LastSeenAt
           FROM (SELECT p.CompletedAt FROM lms.Progress p
                  WHERE p.LearnerId = l.LearnerId
                 UNION ALL
                 SELECT h.CompletedAt FROM lms.ProgressHistory h
                  WHERE h.LearnerId = l.LearnerId) seen
       ) pr
      WHERE l.TenantId = @tenantId
      ORDER BY l.DisplayName ASC`,
    { tenantId },
  );
  return rows.map((r) => ({
    learnerId: r.LearnerId,
    displayName: r.DisplayName,
    email: r.Email,
    status: r.Status,
    enrollments: r.Enrollments,
    completions: r.Completions,
    lastSeenAt: r.LastSeenAt,
  }));
}
