import { execute, query, queryOne } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { learnerAccessibleScope, seatHeldBy } from "@/lib/db/course-scope";
import { ensureEnrollmentPinned, resolveLearnerVersion } from "@/lib/db/versions";

// Completion tracking. The lms.Learner / lms.Enrollment / lms.Progress tables
// already exist (migration 0001) — this module is the wire-up: resolve the
// signed-in user to a Learner, record per-block progress, and roll blocks up
// into a course-level percentage and a done/not-done verdict.

export interface LearnerRef {
  learnerId: string;
  displayName: string;
}

// Resolve (or lazily create) the lms.Learner row for the signed-in user.
// AppUser is the authoring/admin identity; Learner is the training identity —
// one person can be both, keyed separately, joined only by (TenantId, Email).
// azureOid, when known, is stamped so the UI can pull a directory avatar; an
// existing row's AzureOid is backfilled when it was previously null.
//
// The AzureOid column (migration 0010) is touched through sp_executesql so a
// learner upsert still works before 0010 has applied — a static reference to
// a not-yet-created column fails at parse time, breaking every learner page.
export async function resolveLearner(
  tenantId: string,
  email: string,
  displayName: string,
  azureOid?: string,
): Promise<LearnerRef> {
  await execute(
    `IF COL_LENGTH('lms.Learner', 'AzureOid') IS NULL
       MERGE lms.Learner AS target
       USING (SELECT @tenantId AS TenantId, @email AS Email) AS src
         ON target.TenantId = src.TenantId AND target.Email = src.Email
       WHEN NOT MATCHED THEN
         INSERT (LearnerId, TenantId, Email, DisplayName)
         VALUES (NEWID(), @tenantId, @email, @displayName);
     ELSE
       EXEC sp_executesql N'
         MERGE lms.Learner AS target
         USING (SELECT @tenantId AS TenantId, @email AS Email) AS src
           ON target.TenantId = src.TenantId AND target.Email = src.Email
         WHEN MATCHED AND target.AzureOid IS NULL AND @azureOid IS NOT NULL THEN
           UPDATE SET AzureOid = @azureOid
         WHEN NOT MATCHED THEN
           INSERT (LearnerId, TenantId, Email, DisplayName, AzureOid)
           VALUES (NEWID(), @tenantId, @email, @displayName, @azureOid);',
         N'@tenantId uniqueidentifier, @email nvarchar(320),
           @displayName nvarchar(256), @azureOid nvarchar(64)',
         @tenantId = @tenantId, @email = @email,
         @displayName = @displayName, @azureOid = @azureOid;`,
    { tenantId, email, displayName, azureOid: azureOid ?? null },
  );
  const row = await queryOne<{ LearnerId: string; DisplayName: string }>(
    `SELECT LearnerId, DisplayName FROM lms.Learner
      WHERE TenantId = @tenantId AND Email = @email`,
    { tenantId, email },
  );
  if (!row) throw new Error("Learner upsert failed");
  return { learnerId: row.LearnerId, displayName: row.DisplayName };
}

// False, with nothing written, when the course is not open to this learner
// (learnerAccessibleScope: an entitled course needs the learner's seat).
// Otherwise idempotent: if a row already exists its VersionId is left alone. A
// new row pins the version the /learn/[slug] page would
// (resolveLearnerVersion): the assignment's, else the course's current one. A
// learner who hits a progress/complete endpoint first (a deep link) must not
// land on a publisher version the buyer's entitlement never received.
export async function ensureEnrollment(
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<boolean> {
  const open = await queryOne<{ Hit: number }>(
    `SELECT TOP 1 1 AS Hit FROM lms.Course c
      WHERE c.CourseId = @courseId AND ${learnerAccessibleScope()}`,
    { tenantId, learnerId, courseId },
  );
  if (!open) return false;
  const versionId = await resolveLearnerVersion(learnerId, courseId);
  if (!versionId) throw new Error(`Course ${courseId} has no published version to enrol on`);
  await ensureEnrollmentPinned(tenantId, learnerId, courseId, versionId);
  return true;
}

// The block's kind, or null when it is not in the named course. Checked before
// any Progress write: stops a forged blockId from writing FK-orphan rows or
// crossing courses, and lets the beacon refuse a package block.
export async function courseBlockKind(
  blockId: string,
  courseId: string,
): Promise<string | null> {
  const row = await queryOne<{ Kind: string }>(
    `SELECT b.Kind
       FROM lms.Block b
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
      WHERE b.BlockId = @blockId AND l.CourseId = @courseId`,
    { blockId, courseId },
  );
  return row?.Kind ?? null;
}

// A package block's row is written only when its launchable is satisfied
// (docs/plans/2026-10-28-scorm-cmi5-import.md §4.5), so this beacon write never
// matches one: false means nothing was written.
export async function recordBlockProgress(
  learnerId: string,
  blockId: string,
  seconds = 0,
): Promise<boolean> {
  const written = await execute(
    `MERGE lms.Progress AS target
     USING (SELECT @learnerId AS LearnerId, b.BlockId
              FROM lms.Block b
             WHERE b.BlockId = @blockId AND b.Kind <> 'package') AS src
       ON target.LearnerId = src.LearnerId AND target.BlockId = src.BlockId
     WHEN MATCHED THEN UPDATE SET Seconds = target.Seconds + @seconds
     WHEN NOT MATCHED THEN
       INSERT (LearnerId, BlockId, Seconds) VALUES (@learnerId, src.BlockId, @seconds);`,
    { learnerId, blockId, seconds },
  );
  return written > 0;
}

// Reaching the course's final slide means every slide was traversed, so the
// completion endpoint marks all blocks done in one set-based MERGE rather than
// trusting that every per-slide progress beacon landed. Scoped to the
// learner's pinned CourseVersion so completing v1 doesn't mark v2 blocks done.
// Package blocks are left out: only a satisfied launchable completes one.
export async function markAllBlocksComplete(
  learnerId: string,
  courseId: string,
): Promise<void> {
  await execute(
    `MERGE lms.Progress AS target
     USING (
       SELECT b.BlockId
         FROM lms.Block b
         JOIN lms.Lesson l ON l.LessonId = b.LessonId
         JOIN lms.Course c ON c.CourseId = l.CourseId
         LEFT JOIN lms.Enrollment e
           ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
        WHERE l.CourseId = @courseId
          AND b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
          AND l.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
          AND b.Kind <> 'package'
     ) AS src
       ON target.LearnerId = @learnerId AND target.BlockId = src.BlockId
     WHEN NOT MATCHED BY TARGET THEN
       INSERT (LearnerId, BlockId) VALUES (@learnerId, src.BlockId);`,
    { learnerId, courseId },
  );
}

// True only for the call that stamped CompletedAt, so a replayed final slide
// completes nothing twice.
export async function completeEnrollment(
  learnerId: string,
  courseId: string,
): Promise<boolean> {
  const stamped = await execute(
    `UPDATE lms.Enrollment
        SET Status = 'completed', CompletedAt = SYSUTCDATETIME()
      WHERE LearnerId = @learnerId AND CourseId = @courseId AND CompletedAt IS NULL`,
    { learnerId, courseId },
  );
  return stamped > 0;
}

export interface CompletionRow {
  course_id: string;
  slug: string;
  title: string;
  completed_at: string;
}

// Courses this learner has finished in this tenant (Enrollment.CompletedAt is
// stamped by completeEnrollment; while a renewal cycle is open, the previous
// cycle's certificate dates it). Catalogue courses complete inside the
// learner's own tenant, so the enrollment's TenantId is the scope.
export async function listCompletionsForLearner(
  tenantId: string,
  learnerId: string,
): Promise<CompletionRow[]> {
  const rows = await query<{ CourseId: string; Slug: string; Title: string; CompletedAt: Date }>(
    `SELECT CONVERT(varchar(64), e.CourseId) AS CourseId, c.Slug, c.Title,
            ${lastCompletedAt("e")} AS CompletedAt
       FROM lms.Enrollment e
       JOIN lms.Course c ON c.CourseId = e.CourseId
      WHERE e.TenantId = @tenantId
        AND e.LearnerId = @learnerId
        AND ${lastCompletedAt("e")} IS NOT NULL
      ORDER BY CompletedAt DESC`,
    { tenantId, learnerId },
  );
  return rows.map((r) => ({
    course_id: r.CourseId,
    slug: r.Slug,
    title: r.Title,
    completed_at: new Date(r.CompletedAt).toISOString(),
  }));
}

export interface CourseProgress {
  totalBlocks: number;
  completedBlocks: number;
  pct: number;
  completed: boolean;
}

function rollUp(total: number, rawDone: number): CourseProgress {
  const done = Math.min(rawDone, total);
  return {
    totalBlocks: total,
    completedBlocks: done,
    pct: total > 0 ? Math.round((done / total) * 100) : 0,
    completed: total > 0 && done >= total,
  };
}

// Rollup is version-aware: TotalBlocks is the count in the learner's pinned
// version (falling back to Course.CurrentVersionId if they have no
// Enrollment yet). Without this, republishing a course would silently change
// every in-flight learner's progress percentage.
export async function getCourseProgress(
  learnerId: string,
  courseId: string,
): Promise<CourseProgress> {
  const row = await queryOne<{ TotalBlocks: number; DoneBlocks: number }>(
    `WITH pinned AS (
       SELECT COALESCE(e.VersionId, c.CurrentVersionId) AS VersionId
         FROM lms.Course c
         LEFT JOIN lms.Enrollment e
           ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
        WHERE c.CourseId = @courseId
     )
     SELECT
       (SELECT COUNT(*) FROM lms.Block b
          JOIN lms.Lesson l ON l.LessonId = b.LessonId
         WHERE l.CourseId = @courseId
           AND b.VersionId = (SELECT VersionId FROM pinned)) AS TotalBlocks,
       (SELECT COUNT(*) FROM lms.Progress p
          JOIN lms.Block b ON b.BlockId = p.BlockId
          JOIN lms.Lesson l ON l.LessonId = b.LessonId
         WHERE l.CourseId = @courseId
           AND b.VersionId = (SELECT VersionId FROM pinned)
           AND p.LearnerId = @learnerId) AS DoneBlocks`,
    { courseId, learnerId },
  );
  return rollUp(row?.TotalBlocks ?? 0, row?.DoneBlocks ?? 0);
}

// Seen-block list for the player: every block in the learner's pinned version
// of this course that has a Progress row. CoursePlayer uses it for two things:
// (1) resume — jump the initial slide to the first block they haven't seen,
// (2) min-dwell gate — only apply the dwell-time floor on truly-new blocks,
// so re-access stays snappy.
export async function getSeenBlockIds(
  learnerId: string,
  courseId: string,
): Promise<string[]> {
  const rows = await query<{ BlockId: string }>(
    `WITH pinned AS (
       SELECT COALESCE(e.VersionId, c.CurrentVersionId) AS VersionId
         FROM lms.Course c
         LEFT JOIN lms.Enrollment e
           ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
        WHERE c.CourseId = @courseId
     )
     SELECT p.BlockId
       FROM lms.Progress p
       JOIN lms.Block b ON b.BlockId = p.BlockId
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
      WHERE l.CourseId = @courseId
        AND b.VersionId = (SELECT VersionId FROM pinned)
        AND p.LearnerId = @learnerId`,
    { courseId, learnerId },
  );
  return rows.map((r) => r.BlockId);
}

// One round-trip for the dashboard: progress for every course in the tenant,
// scoped to the learner's pinned CourseVersion per course (or
// CurrentVersionId if they haven't enrolled yet). Without the version filter,
// republishing a course would inflate every learner's denominator with v2
// blocks while their Progress rows still reference v1.
//
// Course scope is the catalogue union (migration 0014): the tenant's own
// courses plus any subscribed catalogue course, and an entitled course only
// while the learner holds its seat. The learner's Progress rows stay keyed to
// this tenant — only the course content is shared.
export async function getProgressForLearner(
  tenantId: string,
  learnerId: string,
): Promise<Map<string, CourseProgress>> {
  const rows = await query<{
    CourseId: string;
    TotalBlocks: number;
    DoneBlocks: number;
  }>(
    `SELECT c.CourseId,
            COUNT(b.BlockId) AS TotalBlocks,
            COUNT(p.BlockId) AS DoneBlocks
       FROM lms.Course c
       LEFT JOIN lms.Enrollment e
         ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
       JOIN lms.Lesson l
         ON l.CourseId = c.CourseId
        AND l.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
       JOIN lms.Block  b
         ON b.LessonId = l.LessonId
        AND b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)
       LEFT JOIN lms.Progress p
         ON p.BlockId = b.BlockId AND p.LearnerId = @learnerId
      WHERE (
              c.TenantId = @tenantId
              OR c.CourseId IN (
                SELECT CourseId FROM lms.CatalogSubscription
                 WHERE TenantId = @tenantId
              )
              OR ${seatHeldBy()}
            )
      GROUP BY c.CourseId`,
    { tenantId, learnerId },
  );
  const map = new Map<string, CourseProgress>();
  for (const r of rows) map.set(r.CourseId, rollUp(r.TotalBlocks, r.DoneBlocks));
  return map;
}
