import { execute, queryOne } from "@/lib/db";

// Resolve which CourseVersion a learner is pinned to for a given course.
// Precedence (matches the design doc):
//   1. Enrollment.VersionId  — learner already started; their version is locked.
//   2. CourseAssignment.VersionId — admin assigned the course, set the version
//      at assign time; first-touch enrollment will inherit it.
//   3. Course.CurrentVersionId — public catalog; first-touch enrollment pins
//      to whatever's current at the moment of touch.
// Returns the resolved VersionId, or null if none of the above exist (which
// means the course itself has never been published, an internal bug state).
export async function resolveLearnerVersion(
  learnerId: string,
  courseId: string,
): Promise<string | null> {
  const row = await queryOne<{ VersionId: string | null }>(
    `SELECT TOP 1 CONVERT(varchar(64), VersionId) AS VersionId FROM (
        SELECT 1 AS Priority, e.VersionId
          FROM lms.Enrollment e
         WHERE e.LearnerId = @learnerId AND e.CourseId = @courseId
        UNION ALL
        SELECT 2 AS Priority, a.VersionId
          FROM lms.CourseAssignment a
         WHERE a.LearnerId = @learnerId AND a.CourseId = @courseId
        UNION ALL
        SELECT 3 AS Priority, c.CurrentVersionId
          FROM lms.Course c
         WHERE c.CourseId = @courseId
     ) src
     WHERE VersionId IS NOT NULL
     ORDER BY Priority ASC`,
    { learnerId, courseId },
  );
  return row?.VersionId ?? null;
}

// First-touch enrollment: idempotently create an Enrollment row pinned to the
// supplied VersionId. If a row already exists its VersionId is left alone —
// re-pinning a learner mid-course is an explicit admin action, not a side
// effect of revisiting the player page.
export async function ensureEnrollmentPinned(
  tenantId: string,
  learnerId: string,
  courseId: string,
  versionId: string,
): Promise<void> {
  await execute(
    `MERGE lms.Enrollment AS target
     USING (SELECT @learnerId AS LearnerId, @courseId AS CourseId) AS src
       ON target.LearnerId = src.LearnerId AND target.CourseId = src.CourseId
     WHEN NOT MATCHED THEN
       INSERT (EnrollmentId, TenantId, LearnerId, CourseId, VersionId, Status)
       VALUES (NEWID(), @tenantId, @learnerId, @courseId, @versionId, 'active');`,
    { tenantId, learnerId, courseId, versionId },
  );
}

export interface CourseVersionRow {
  VersionId: string;
  VersionNumber: number;
  PublishedAt: Date;
  PublishedBy: string;
  ChangeNote: string | null;
}
