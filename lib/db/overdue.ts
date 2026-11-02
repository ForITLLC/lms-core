import { query } from "@/lib/db";
import { MANDATORY_FOR_TENANT, TENANT_VISIBLE_SCOPE, learnerAccessibleScope } from "@/lib/db/course-scope";

// Overdue learning items for the weekly Monday digest. A learner is overdue on
// a mandatory curriculum course when EITHER:
//   1. their latest cycle's cert has expired (annual / recurring rolled over), OR
//   2. they have no cert at all and the schedule says they should by now
//      (annual past the 30-day new-hire grace, or recurring anchor + months).
//
// Evergreen courses (ScheduleKind = NULL, RecurrenceMonths = NULL) are never
// overdue — completing them once is enough. Non-mandatory courses are never
// overdue either; the curriculum is the source of truth for what's required.

export type OverdueReason =
  | "expired_cert"
  | "never_completed"
  | "recurring_lapsed";

export interface OverdueItem {
  learnerId: string;
  email: string;
  displayName: string;
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  overdueReason: OverdueReason;
  dueDate: Date | null;
}

interface RawRow {
  LearnerId: string;
  Email: string;
  DisplayName: string;
  CourseId: string;
  CourseTitle: string;
  CourseSlug: string;
  OverdueReason: OverdueReason;
  DueDate: Date | null;
}

const ANNUAL_GRACE_DAYS = 30;

// Returns every (learner, mandatory course) pair that is currently overdue for
// the given tenant. Learner, curriculum and certificate rows are tenant-scoped
// at every join; the only cross-tenant reads are the course scopes (a
// subscribed catalogue course can be mandatory, and an entitled one is
// mandatory only for a learner holding its seat). Annual-grace math uses Learner.CreatedAt
// as the start anchor since the schema doesn't carry an explicit hire date
// today (matches what lib/db/schedule.ts uses when startDate is null).
export async function listOverdueForTenant(
  tenantId: string,
): Promise<OverdueItem[]> {
  const rows = await query<RawRow>(
    `
    WITH mandatory_for_tenant AS (
      SELECT c.CourseId, c.Title AS CourseTitle, c.Slug AS CourseSlug,
             c.ScheduleKind, c.RecurrenceMonths
        FROM lms.Course c
       WHERE ${TENANT_VISIBLE_SCOPE}
         AND ${MANDATORY_FOR_TENANT}
         AND c.Status = 'published'
    ),
    learner_course AS (
      SELECT l.LearnerId, l.Email, l.DisplayName, l.CreatedAt AS LearnerStart,
             m.CourseId, m.CourseTitle, m.CourseSlug,
             m.ScheduleKind, m.RecurrenceMonths
        FROM lms.Learner l
        CROSS JOIN mandatory_for_tenant m
        JOIN lms.Course c ON c.CourseId = m.CourseId AND ${learnerAccessibleScope("l.LearnerId")}
       WHERE l.TenantId = @tenantId
         AND l.Status = 'active'
    ),
    with_cert AS (
      SELECT lc.*, latest.IssuedAt AS CertIssuedAt, latest.ExpiresAt AS CertExpiresAt
        FROM learner_course lc
        OUTER APPLY (
          SELECT TOP 1 cert.IssuedAt, cert.ExpiresAt
            FROM lms.Certificate cert
           WHERE cert.LearnerId = lc.LearnerId
             AND cert.CourseId  = lc.CourseId
             AND cert.TenantId  = @tenantId
             AND cert.RevokedAt IS NULL
           ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC, cert.CertificateId DESC
        ) latest
    )
    SELECT
      CONVERT(varchar(64), LearnerId) AS LearnerId,
      Email, DisplayName,
      CONVERT(varchar(64), CourseId) AS CourseId,
      CourseTitle, CourseSlug,
      CASE
        WHEN CertExpiresAt IS NOT NULL AND CertExpiresAt <= SYSUTCDATETIME()
          THEN 'expired_cert'
        WHEN CertIssuedAt IS NULL
          THEN 'never_completed'
        ELSE 'recurring_lapsed'
      END AS OverdueReason,
      CASE
        WHEN CertExpiresAt IS NOT NULL THEN CertExpiresAt
        WHEN ScheduleKind = 'annual' THEN
          DATEFROMPARTS(YEAR(DATEADD(DAY, @annualGraceDays, LearnerStart)) + 1, 1, 31)
        WHEN ScheduleKind = 'recurring' AND RecurrenceMonths IS NOT NULL THEN
          DATEADD(MONTH, RecurrenceMonths, LearnerStart)
        ELSE NULL
      END AS DueDate
      FROM with_cert
     WHERE
       -- (1) cert exists and has expired
       (CertExpiresAt IS NOT NULL AND CertExpiresAt <= SYSUTCDATETIME())
       -- (2) no cert AND schedule says they should have one by now
       OR (
         CertIssuedAt IS NULL
         AND (
           (ScheduleKind = 'annual'
             AND DATEADD(DAY, @annualGraceDays, LearnerStart) <= SYSUTCDATETIME()
             AND DATEFROMPARTS(YEAR(SYSUTCDATETIME()), 1, 31) <= SYSUTCDATETIME())
           OR (ScheduleKind = 'recurring'
             AND RecurrenceMonths IS NOT NULL
             AND DATEADD(MONTH, RecurrenceMonths, LearnerStart) <= SYSUTCDATETIME())
           OR (ScheduleKind IS NULL)
         )
       )
     ORDER BY Email, CourseTitle
    `,
    { tenantId, curriculumId: null, annualGraceDays: ANNUAL_GRACE_DAYS },
  );

  return rows.map((r) => ({
    learnerId: r.LearnerId,
    email: r.Email,
    displayName: r.DisplayName,
    courseId: r.CourseId,
    courseTitle: r.CourseTitle,
    courseSlug: r.CourseSlug,
    overdueReason: r.OverdueReason,
    dueDate: r.DueDate ? new Date(r.DueDate) : null,
  }));
}

export interface LearnerOverdueGroup {
  learnerId: string;
  email: string;
  displayName: string;
  items: OverdueItem[];
}

// Convenience: group a flat result by learner so the digest can render one
// email per recipient.
export function groupByLearner(items: OverdueItem[]): LearnerOverdueGroup[] {
  const byId = new Map<string, LearnerOverdueGroup>();
  for (const it of items) {
    let g = byId.get(it.learnerId);
    if (!g) {
      g = {
        learnerId: it.learnerId,
        email: it.email,
        displayName: it.displayName,
        items: [],
      };
      byId.set(it.learnerId, g);
    }
    g.items.push(it);
  }
  return Array.from(byId.values());
}
