import { query, queryOne } from "@/lib/db";
import { MANDATORY_FOR_TENANT, learnerAccessibleScope } from "@/lib/db/course-scope";

// Tiered-dashboard helpers. Same scoping discipline as lib/db/overdue.ts:
// tenant-scoped at every join; only learnerAccessibleScope reads catalogue and
// entitled courses, an entitled one only for a learner holding its seat. The
// three queries here back the Required / Upcoming / Optional tiers on the
// learner dashboard, plus a small summary rollup for the KPI strip.
//
// Time-window split (locked 2026-05-17):
//   Required  = handled by lib/db/overdue.ts (overdue + already-due items)
//   Upcoming  = mandatory courses due in 1..60d, NOT yet overdue
//   Optional  = every published non-mandatory course in the curriculum,
//               annotated with the learner's progress + enrollment state.
//
// Annual grace = 30 days from Learner.CreatedAt (mirrors overdue.ts).

const ANNUAL_GRACE_DAYS = 30;
const UPCOMING_WINDOW_DAYS = 60;

export type UpcomingReason = "cert_renewing" | "first_due" | "recurring_due";

export interface UpcomingItem {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  dueDate: Date;
  daysUntilDue: number;
  upcomingReason: UpcomingReason;
}

interface UpcomingRow {
  CourseId: string;
  CourseTitle: string;
  CourseSlug: string;
  DueDate: Date;
  DaysUntilDue: number;
  UpcomingReason: UpcomingReason;
}

// Mandatory courses due in 1..windowDays days for this learner (NOT overdue).
// Powers the Upcoming tier. Tenant-scoped at every join. Mirrors the math in
// lib/db/overdue.ts so the two queries can never disagree about a due date.
export async function listUpcomingForLearner(
  tenantId: string,
  learnerId: string,
  opts: { windowDays?: number } = {},
): Promise<UpcomingItem[]> {
  const windowDays = opts.windowDays ?? UPCOMING_WINDOW_DAYS;
  const rows = await query<UpcomingRow>(
    `
    WITH mandatory_for_tenant AS (
      SELECT c.CourseId, c.Title AS CourseTitle, c.Slug AS CourseSlug,
             c.ScheduleKind, c.RecurrenceMonths
        FROM lms.Course c
       WHERE ${learnerAccessibleScope()}
         AND ${MANDATORY_FOR_TENANT}
         AND c.Status = 'published'
    ),
    learner_anchor AS (
      SELECT CreatedAt AS LearnerStart
        FROM lms.Learner
       WHERE TenantId = @tenantId AND LearnerId = @learnerId
    ),
    with_cert AS (
      SELECT m.CourseId, m.CourseTitle, m.CourseSlug,
             m.ScheduleKind, m.RecurrenceMonths,
             la.LearnerStart,
             latest.IssuedAt  AS CertIssuedAt,
             latest.ExpiresAt AS CertExpiresAt
        FROM mandatory_for_tenant m
        CROSS JOIN learner_anchor la
        OUTER APPLY (
          SELECT TOP 1 cert.IssuedAt, cert.ExpiresAt
            FROM lms.Certificate cert
           WHERE cert.LearnerId = @learnerId
             AND cert.CourseId  = m.CourseId
             AND cert.TenantId  = @tenantId
             AND cert.RevokedAt IS NULL
           ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC, cert.CertificateId DESC
        ) latest
    ),
    computed AS (
      SELECT CONVERT(varchar(64), CourseId) AS CourseId,
             CourseTitle, CourseSlug,
             CASE
               WHEN CertExpiresAt IS NOT NULL THEN CertExpiresAt
               WHEN ScheduleKind = 'annual' THEN
                 DATEFROMPARTS(YEAR(DATEADD(DAY, @annualGraceDays, LearnerStart)) + 1, 1, 31)
               WHEN ScheduleKind = 'recurring' AND RecurrenceMonths IS NOT NULL THEN
                 DATEADD(MONTH, RecurrenceMonths, COALESCE(CertIssuedAt, LearnerStart))
               ELSE NULL
             END AS DueDate,
             CASE
               WHEN CertExpiresAt IS NOT NULL THEN 'cert_renewing'
               WHEN CertIssuedAt IS NULL THEN 'first_due'
               ELSE 'recurring_due'
             END AS UpcomingReason
        FROM with_cert
    )
    SELECT CourseId, CourseTitle, CourseSlug,
           DueDate,
           DATEDIFF(DAY, SYSUTCDATETIME(), DueDate) AS DaysUntilDue,
           UpcomingReason
      FROM computed
     WHERE DueDate IS NOT NULL
       AND DATEDIFF(DAY, SYSUTCDATETIME(), DueDate) BETWEEN 1 AND @windowDays
     ORDER BY DueDate ASC, CourseTitle ASC
    `,
    {
      tenantId,
      learnerId,
      curriculumId: null,
      annualGraceDays: ANNUAL_GRACE_DAYS,
      windowDays,
    },
  );
  return rows.map((r) => ({
    courseId: r.CourseId,
    courseTitle: r.CourseTitle,
    courseSlug: r.CourseSlug,
    dueDate: new Date(r.DueDate),
    daysUntilDue: r.DaysUntilDue,
    upcomingReason: r.UpcomingReason,
  }));
}

export interface OptionalItem {
  courseId: string;
  courseTitle: string;
  courseSlug: string;
  description: string | null;
  category: string | null;
  progressPct: number;
  completed: boolean;
}

interface OptionalRow {
  CourseId: string;
  CourseTitle: string;
  CourseSlug: string;
  Description: string | null;
  Category: string | null;
  TotalBlocks: number;
  DoneBlocks: number;
  CourseCompleted: boolean | number;
}

// Every published non-mandatory course in scope for this learner's tenant,
// annotated with the learner's progress so the dashboard can render "Continue"
// vs "Start" without a second round-trip. Courses NOT yet on the curriculum
// surface here too (they're inherently optional). Scope is the tenant's own
// published courses plus any subscribed ForIT catalogue course (migration
// 0014) — learnerAccessibleScope, so subscribed courses show in the Optional
// tier, and an entitled course shows only to a learner holding its seat.
export async function listOptionalForLearner(
  tenantId: string,
  learnerId: string,
): Promise<OptionalItem[]> {
  const rows = await query<OptionalRow>(
    `
    WITH mandatory_courses AS (
      SELECT cc.CourseId
        FROM lms.CurriculumCourse cc
        JOIN lms.Curriculum cu ON cu.CurriculumId = cc.CurriculumId
       WHERE cu.TenantId = @tenantId
         AND cc.IsMandatory = 1
    )
    SELECT CONVERT(varchar(64), c.CourseId) AS CourseId,
           c.Title       AS CourseTitle,
           c.Slug        AS CourseSlug,
           c.Description AS Description,
           c.Category    AS Category,
           CASE WHEN e.CompletedAt IS NOT NULL THEN 1 ELSE 0 END AS CourseCompleted,
           (SELECT COUNT(*) FROM lms.Block b
              JOIN lms.Lesson l ON l.LessonId = b.LessonId
             WHERE l.CourseId = c.CourseId
               AND b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)) AS TotalBlocks,
           (SELECT COUNT(*) FROM lms.Progress p
              JOIN lms.Block b  ON b.BlockId = p.BlockId
              JOIN lms.Lesson l ON l.LessonId = b.LessonId
             WHERE l.CourseId = c.CourseId AND p.LearnerId = @learnerId
               AND b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)) AS DoneBlocks
      FROM lms.Course c
      LEFT JOIN lms.Enrollment e
        ON e.CourseId = c.CourseId
       AND e.LearnerId = @learnerId
       AND e.TenantId = @tenantId
     WHERE ${learnerAccessibleScope()}
       AND c.Status   = 'published'
       AND NOT EXISTS (SELECT 1 FROM mandatory_courses m WHERE m.CourseId = c.CourseId)
     ORDER BY c.Title ASC
    `,
    { tenantId, learnerId },
  );
  return rows.map((r) => {
    const done = Math.min(r.DoneBlocks, r.TotalBlocks);
    const pct = r.TotalBlocks > 0 ? Math.round((done / r.TotalBlocks) * 100) : 0;
    return {
      courseId: r.CourseId,
      courseTitle: r.CourseTitle,
      courseSlug: r.CourseSlug,
      description: r.Description,
      category: r.Category,
      progressPct: pct,
      completed: !!r.CourseCompleted,
    };
  });
}

export interface DashboardSummary {
  requiredCount: number;
  upcomingCount: number;
  certificatesValid: number;
}

// One-row rollup for the KPI hero strip. Counts are derived from the same
// CTEs that drive the tier queries so the strip and the lists can never
// drift. `certificatesValid` counts each course's latest-cycle cert, if unexpired.
export async function getDashboardSummary(
  tenantId: string,
  learnerId: string,
): Promise<DashboardSummary> {
  const row = await queryOne<{
    RequiredCount: number;
    UpcomingCount: number;
    CertificatesValid: number;
  }>(
    `
    WITH mandatory_for_tenant AS (
      SELECT c.CourseId, c.ScheduleKind, c.RecurrenceMonths
        FROM lms.Course c
       WHERE ${learnerAccessibleScope()}
         AND ${MANDATORY_FOR_TENANT}
         AND c.Status = 'published'
    ),
    learner_anchor AS (
      SELECT CreatedAt AS LearnerStart
        FROM lms.Learner
       WHERE TenantId = @tenantId AND LearnerId = @learnerId
    ),
    with_cert AS (
      SELECT m.CourseId, m.ScheduleKind, m.RecurrenceMonths,
             la.LearnerStart,
             latest.IssuedAt  AS CertIssuedAt,
             latest.ExpiresAt AS CertExpiresAt
        FROM mandatory_for_tenant m
        CROSS JOIN learner_anchor la
        OUTER APPLY (
          SELECT TOP 1 cert.IssuedAt, cert.ExpiresAt
            FROM lms.Certificate cert
           WHERE cert.LearnerId = @learnerId
             AND cert.CourseId  = m.CourseId
             AND cert.TenantId  = @tenantId
             AND cert.RevokedAt IS NULL
           ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC, cert.CertificateId DESC
        ) latest
    ),
    state AS (
      SELECT
        CASE
          WHEN CertExpiresAt IS NOT NULL AND CertExpiresAt <= SYSUTCDATETIME() THEN 'overdue'
          WHEN CertIssuedAt IS NULL AND (
                 (ScheduleKind = 'annual'
                   AND DATEADD(DAY, @annualGraceDays, LearnerStart) <= SYSUTCDATETIME()
                   AND DATEFROMPARTS(YEAR(SYSUTCDATETIME()), 1, 31) <= SYSUTCDATETIME())
              OR (ScheduleKind = 'recurring'
                   AND RecurrenceMonths IS NOT NULL
                   AND DATEADD(MONTH, RecurrenceMonths, LearnerStart) <= SYSUTCDATETIME())
              OR (ScheduleKind IS NULL)
             ) THEN 'overdue'
          ELSE 'ok'
        END AS RequiredState,
        CASE
          WHEN CertExpiresAt IS NOT NULL THEN CertExpiresAt
          WHEN ScheduleKind = 'annual' THEN
            DATEFROMPARTS(YEAR(DATEADD(DAY, @annualGraceDays, LearnerStart)) + 1, 1, 31)
          WHEN ScheduleKind = 'recurring' AND RecurrenceMonths IS NOT NULL THEN
            DATEADD(MONTH, RecurrenceMonths, COALESCE(CertIssuedAt, LearnerStart))
          ELSE NULL
        END AS DueDate
        FROM with_cert
    )
    SELECT
      (SELECT COUNT(*) FROM state WHERE RequiredState = 'overdue') AS RequiredCount,
      (SELECT COUNT(*) FROM state
        WHERE DueDate IS NOT NULL
          AND DATEDIFF(DAY, SYSUTCDATETIME(), DueDate) BETWEEN 1 AND @upcomingWindow) AS UpcomingCount,
      (SELECT COUNT(*) FROM lms.Certificate cer
        WHERE cer.LearnerId = @learnerId
          AND cer.TenantId  = @tenantId
          AND cer.RevokedAt IS NULL
          AND (cer.ExpiresAt IS NULL OR cer.ExpiresAt > SYSUTCDATETIME())
          AND NOT EXISTS (SELECT 1 FROM lms.Certificate newer
                           WHERE newer.LearnerId = cer.LearnerId
                             AND newer.CourseId  = cer.CourseId
                             AND newer.TenantId  = cer.TenantId
                             AND newer.RevokedAt IS NULL
                             AND newer.CycleNo   > cer.CycleNo)) AS CertificatesValid
    `,
    {
      tenantId,
      learnerId,
      curriculumId: null,
      annualGraceDays: ANNUAL_GRACE_DAYS,
      upcomingWindow: UPCOMING_WINDOW_DAYS,
    },
  );
  return {
    requiredCount: row?.RequiredCount ?? 0,
    upcomingCount: row?.UpcomingCount ?? 0,
    certificatesValid: row?.CertificatesValid ?? 0,
  };
}
