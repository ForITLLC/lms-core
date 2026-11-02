import { query, queryOne } from "@/lib/db";
import { lastCompletedAt } from "@/lib/db/completion";
import { TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";

// Read models for the admin/author per-course detail page
// (app/admin/courses/[slug]). Three things a course owner needs in one place:
// the version history, every enrolled learner's progress, and the feedback
// learners have left. Every query is tenant-scoped — TenantId comes from the
// session, never the request.

export interface CourseAdminRef {
  courseId: string;
  title: string;
  slug: string;
  status: string;
  currentVersionId: string | null;
  isCatalog: boolean;
  // Owner (migration 0011). ownerName is the resolved display label —
  // AppUser.DisplayName for a person owner, ownerGroupName for a group.
  ownerUserId: string | null;
  ownerGroupId: string | null;
  ownerGroupName: string | null;
  ownerName: string | null;
}

export async function resolveCourseAdmin(
  tenantId: string,
  slug: string,
): Promise<CourseAdminRef | null> {
  const row = await queryOne<{
    CourseId: string;
    Title: string;
    Slug: string;
    Status: string;
    CurrentVersionId: string | null;
    IsCatalog: boolean;
    OwnerUserId: string | null;
    OwnerGroupId: string | null;
    OwnerGroupName: string | null;
    OwnerName: string | null;
  }>(
    `SELECT CONVERT(varchar(64), c.CourseId) AS CourseId,
            c.Title, c.Slug, c.Status,
            CONVERT(varchar(64), c.CurrentVersionId) AS CurrentVersionId,
            c.IsCatalog,
            CONVERT(varchar(64), c.OwnerUserId) AS OwnerUserId,
            c.OwnerGroupId, c.OwnerGroupName,
            CASE WHEN c.OwnerUserId IS NOT NULL THEN ou.DisplayName
                 WHEN c.OwnerGroupId IS NOT NULL THEN c.OwnerGroupName
                 ELSE NULL END AS OwnerName
       FROM lms.Course c
       LEFT JOIN lms.AppUser ou ON ou.AppUserId = c.OwnerUserId
      WHERE c.TenantId = @tenantId AND c.Slug = @slug`,
    { tenantId, slug },
  );
  if (!row) return null;
  return {
    courseId: row.CourseId,
    title: row.Title,
    slug: row.Slug,
    status: row.Status,
    currentVersionId: row.CurrentVersionId,
    isCatalog: !!row.IsCatalog,
    ownerUserId: row.OwnerUserId,
    ownerGroupId: row.OwnerGroupId,
    ownerGroupName: row.OwnerGroupName,
    ownerName: row.OwnerName,
  };
}

// The learner-status read (the REST progress endpoint) also covers subscribed
// catalogue courses. The author view above stays own-only: versions, owners
// and feedback belong to the publisher.
export async function resolveCourseInScope(
  tenantId: string,
  slug: string,
): Promise<{ courseId: string; title: string; slug: string; status: string } | null> {
  const row = await queryOne<{ CourseId: string; Title: string; Slug: string; Status: string }>(
    `SELECT CONVERT(varchar(64), c.CourseId) AS CourseId, c.Title, c.Slug, c.Status
       FROM lms.Course c
      WHERE c.Slug = @slug AND ${TENANT_VISIBLE_SCOPE}`,
    { tenantId, slug },
  );
  return row ? { courseId: row.CourseId, title: row.Title, slug: row.Slug, status: row.Status } : null;
}

export interface CourseVersionSummary {
  versionId: string;
  versionNumber: number;
  publishedAt: Date;
  publishedBy: string;
  changeNote: string | null;
  isCurrent: boolean;
  lessonCount: number;
  blockCount: number;
  enrollmentCount: number;
}

// Full version history for a course, newest first. lessonCount/blockCount are
// per-version (blocks are recreated per CourseVersion, migration 0008);
// enrollmentCount is how many learners are pinned to that exact version.
export async function listCourseVersions(
  tenantId: string,
  courseId: string,
): Promise<CourseVersionSummary[]> {
  const rows = await query<{
    VersionId: string;
    VersionNumber: number;
    PublishedAt: Date;
    PublishedBy: string;
    ChangeNote: string | null;
    IsCurrent: number;
    LessonCount: number;
    BlockCount: number;
    EnrollmentCount: number;
  }>(
    `SELECT CONVERT(varchar(64), v.VersionId) AS VersionId,
            v.VersionNumber, v.PublishedAt, v.PublishedBy, v.ChangeNote,
            CASE WHEN c.CurrentVersionId = v.VersionId THEN 1 ELSE 0 END AS IsCurrent,
            (SELECT COUNT(*) FROM lms.Lesson les
              WHERE les.CourseId = v.CourseId AND les.VersionId = v.VersionId) AS LessonCount,
            (SELECT COUNT(*) FROM lms.Block b
               JOIN lms.Lesson les ON les.LessonId = b.LessonId
              WHERE les.CourseId = v.CourseId AND b.VersionId = v.VersionId) AS BlockCount,
            (SELECT COUNT(*) FROM lms.Enrollment e
              WHERE e.CourseId = v.CourseId AND e.VersionId = v.VersionId
                AND e.TenantId = @tenantId) AS EnrollmentCount
       FROM lms.CourseVersion v
       JOIN lms.Course c ON c.CourseId = v.CourseId
      WHERE c.TenantId = @tenantId AND v.CourseId = @courseId
      ORDER BY v.VersionNumber DESC`,
    { tenantId, courseId },
  );
  return rows.map((r) => ({
    versionId: r.VersionId,
    versionNumber: r.VersionNumber,
    publishedAt: r.PublishedAt,
    publishedBy: r.PublishedBy,
    changeNote: r.ChangeNote,
    isCurrent: !!r.IsCurrent,
    lessonCount: r.LessonCount,
    blockCount: r.BlockCount,
    enrollmentCount: r.EnrollmentCount,
  }));
}

export interface CourseLearnerStatus {
  learnerId: string;
  displayName: string;
  email: string;
  azureOid: string | null;
  status: string;
  enrolledAt: Date;
  completedAt: Date | null;
  renewing: boolean;
  pinnedVersionNumber: number | null;
  totalBlocks: number;
  doneBlocks: number;
  pct: number;
}

// Per-learner progress for one course. Block counts are scoped to each
// learner's pinned version (falling back to CurrentVersionId when the
// Enrollment predates 0008 and has a null VersionId), so a learner mid-way
// through v1 isn't measured against v2's block count. completedAt is when the
// learner last finished the course; while a renewal cycle is open it is the
// previous cycle's certificate, and renewing is set.
//
// l.AzureOid (migration 0010) is selected through sp_executesql so the page
// keeps working in the window between this code deploying and 0010 applying
// the column — a static reference to a not-yet-created column fails at parse
// time, before any COL_LENGTH guard runs.
export async function getCourseLearnerStatus(
  tenantId: string,
  courseId: string,
): Promise<CourseLearnerStatus[]> {
  const rows = await query<{
    LearnerId: string;
    DisplayName: string;
    Email: string;
    AzureOid: string | null;
    Status: string;
    EnrolledAt: Date;
    CompletedAt: Date | null;
    CycleCompletedAt: Date | null;
    PinnedVersionNumber: number | null;
    TotalBlocks: number;
    DoneBlocks: number;
  }>(
    `DECLARE @oidCol nvarchar(32) =
       CASE WHEN COL_LENGTH('lms.Learner', 'AzureOid') IS NULL
            THEN N'CAST(NULL AS nvarchar(64))' ELSE N'l.AzureOid' END;
     DECLARE @sql nvarchar(max) = N'
       SELECT CONVERT(varchar(64), e.LearnerId) AS LearnerId,
              l.DisplayName, l.Email,
              ' + @oidCol + N' AS AzureOid,
              e.Status, e.EnrolledAt, e.CompletedAt AS CycleCompletedAt,
              ${lastCompletedAt("e")} AS CompletedAt,
              v.VersionNumber AS PinnedVersionNumber,
              ISNULL(tot.TotalBlocks, 0)  AS TotalBlocks,
              ISNULL(done.DoneBlocks, 0)  AS DoneBlocks
         FROM lms.Enrollment e
         JOIN lms.Learner l ON l.LearnerId = e.LearnerId
         LEFT JOIN lms.CourseVersion v ON v.VersionId = e.VersionId
         OUTER APPLY (
           SELECT COUNT(*) AS TotalBlocks
             FROM lms.Block b
             JOIN lms.Lesson les ON les.LessonId = b.LessonId
            WHERE les.CourseId = e.CourseId
              AND b.VersionId = COALESCE(e.VersionId,
                    (SELECT CurrentVersionId FROM lms.Course WHERE CourseId = e.CourseId))
         ) tot
         OUTER APPLY (
           SELECT COUNT(*) AS DoneBlocks
             FROM lms.Progress p
             JOIN lms.Block b ON b.BlockId = p.BlockId
             JOIN lms.Lesson les ON les.LessonId = b.LessonId
            WHERE les.CourseId = e.CourseId
              AND p.LearnerId = e.LearnerId
              AND b.VersionId = COALESCE(e.VersionId,
                    (SELECT CurrentVersionId FROM lms.Course WHERE CourseId = e.CourseId))
         ) done
        WHERE e.TenantId = @tenantId AND e.CourseId = @courseId
        ORDER BY l.DisplayName ASC';
     EXEC sp_executesql @sql,
       N'@tenantId uniqueidentifier, @courseId uniqueidentifier',
       @tenantId = @tenantId, @courseId = @courseId;`,
    { tenantId, courseId },
  );
  return rows.map((r) => {
    const done = Math.min(r.DoneBlocks, r.TotalBlocks);
    return {
      learnerId: r.LearnerId,
      displayName: r.DisplayName,
      email: r.Email,
      azureOid: r.AzureOid,
      status: r.Status,
      enrolledAt: r.EnrolledAt,
      completedAt: r.CompletedAt,
      renewing: r.CompletedAt !== null && r.CycleCompletedAt === null,
      pinnedVersionNumber: r.PinnedVersionNumber,
      totalBlocks: r.TotalBlocks,
      doneBlocks: done,
      pct: r.TotalBlocks > 0 ? Math.round((done / r.TotalBlocks) * 100) : 0,
    };
  });
}
