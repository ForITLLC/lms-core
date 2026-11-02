import { execute, query, queryOne } from "@/lib/db";
import { ENTITLEMENT_LIVE, SUBSCRIBED_IN_SCOPE, TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";
import { retryDeadlockOnce } from "@/lib/db/deadlock";

// Manual course assignment: an admin picks a learner and a course, the
// learner's Course catalog is augmented with a due-date and the assignment
// pins the CourseVersion at assign-time so the learner takes that version
// even if the course is republished later. See
// docs/plans/2026-05-18-course-versioning-and-assignment-design.md.

export interface CourseAssignmentRow {
  AssignmentId: string;
  LearnerId: string;
  LearnerEmail: string;
  LearnerName: string;
  CourseId: string;
  CourseSlug: string;
  CourseTitle: string;
  VersionId: string;
  VersionNumber: number;
  AssignedBy: string;
  AssignedAt: Date;
  DueDate: Date | null;
  Note: string | null;
  Status: string;
}

export async function listAssignmentsForLearner(
  tenantId: string,
  learnerEmail: string,
): Promise<CourseAssignmentRow[]> {
  return await query<CourseAssignmentRow>(
    `SELECT CONVERT(varchar(64), a.AssignmentId) AS AssignmentId,
            CONVERT(varchar(64), a.LearnerId)    AS LearnerId,
            lr.Email       AS LearnerEmail,
            lr.DisplayName AS LearnerName,
            CONVERT(varchar(64), a.CourseId)    AS CourseId,
            c.Slug         AS CourseSlug,
            c.Title        AS CourseTitle,
            CONVERT(varchar(64), a.VersionId)   AS VersionId,
            v.VersionNumber,
            a.AssignedBy,
            a.AssignedAt,
            a.DueDate,
            a.Note,
            a.Status
       FROM lms.CourseAssignment a
       JOIN lms.Learner       lr ON lr.LearnerId = a.LearnerId
       JOIN lms.Course        c  ON c.CourseId   = a.CourseId
       JOIN lms.CourseVersion v  ON v.VersionId  = a.VersionId
      WHERE a.TenantId = @tenantId
        AND lr.Email = @learnerEmail
      ORDER BY a.AssignedAt DESC`,
    { tenantId, learnerEmail },
  );
}

export async function listAssignmentsForCourse(
  tenantId: string,
  courseSlug: string,
): Promise<CourseAssignmentRow[]> {
  return await query<CourseAssignmentRow>(
    `SELECT CONVERT(varchar(64), a.AssignmentId) AS AssignmentId,
            CONVERT(varchar(64), a.LearnerId)    AS LearnerId,
            lr.Email       AS LearnerEmail,
            lr.DisplayName AS LearnerName,
            CONVERT(varchar(64), a.CourseId)    AS CourseId,
            c.Slug         AS CourseSlug,
            c.Title        AS CourseTitle,
            CONVERT(varchar(64), a.VersionId)   AS VersionId,
            v.VersionNumber,
            a.AssignedBy,
            a.AssignedAt,
            a.DueDate,
            a.Note,
            a.Status
       FROM lms.CourseAssignment a
       JOIN lms.Learner       lr ON lr.LearnerId = a.LearnerId
       JOIN lms.Course        c  ON c.CourseId   = a.CourseId
       JOIN lms.CourseVersion v  ON v.VersionId  = a.VersionId
      WHERE a.TenantId = @tenantId AND c.Slug = @courseSlug AND ${TENANT_VISIBLE_SCOPE}
      ORDER BY a.AssignedAt DESC`,
    { tenantId, courseSlug },
  );
}

export interface AssignmentResolution {
  learnerId: string;
  learnerEmail: string;
  learnerName: string;
  courseId: string;
  courseTitle: string;
  versionId: string;
  assignmentId: string;
  entitlementId: string | null;
  created: boolean;
}

// The oldest live entitlement of this tenant on this course with a seat free.
// A seat is an active assignment row carrying the EntitlementId; unassigning
// deletes the row (lib/db/entitlements.ts counts seats the same way). Under
// read-committed snapshot, Azure SQL's default, an unhinted read sees rows as
// of statement start and misses a seat taken while this statement waited, so
// both reads are locking: UPDLOCK makes two claims on one entitlement queue on
// its row, and HOLDLOCK holds the counted range until the claiming write
// commits. Two claims, or a claim and the §3 seat UPDATE, can take those locks
// in opposite orders and deadlock; the claim that loses is retried once.
// Expects @tenantId and @courseId.
export const FREE_SEAT = `SELECT TOP 1 ent.EntitlementId, ent.VersionId
       FROM lms.Entitlement ent WITH (UPDLOCK, HOLDLOCK)
      WHERE ent.TenantId = @tenantId
        AND ent.CourseId = @courseId
        AND ${ENTITLEMENT_LIVE}
        AND ent.Seats > (
          SELECT COUNT(*) FROM lms.CourseAssignment held WITH (UPDLOCK, HOLDLOCK)
           WHERE held.TenantId = ent.TenantId
             AND held.EntitlementId = ent.EntitlementId
             AND held.Status = 'active'
        )
      ORDER BY ent.CreatedAt ASC, ent.EntitlementId ASC`;

// Idempotent on (TenantId, LearnerId, CourseId). On conflict the existing
// assignment is updated (due date / note / assignedBy) but its VersionId is
// left alone — re-running this with a stale CurrentVersionId must not silently
// re-pin a learner to a newer version.
//
// A course the tenant reaches only through a marketplace entitlement takes a
// seat: the assignment records the entitlement and pins its VersionId, and
// the seat is claimed in the same statement that writes the row. A learner
// who already holds a seat on a live entitlement takes no second one.
export async function upsertCourseAssignment(opts: {
  tenantId: string;
  learnerEmail: string;
  courseSlug: string;
  assignedBy: string;
  dueDate?: Date | null;
  note?: string | null;
}): Promise<AssignmentResolution> {
  const learner = await queryOne<{
    LearnerId: string;
    Email: string;
    DisplayName: string;
    Status?: string | null;
  }>(
    `SELECT CONVERT(varchar(64), LearnerId) AS LearnerId, Email, DisplayName, Status
       FROM lms.Learner
      WHERE TenantId = @tenantId AND Email = @email`,
    { tenantId: opts.tenantId, email: opts.learnerEmail },
  );
  if (!learner) {
    throw new AssignmentError(
      "learner_not_found",
      `No learner with email ${opts.learnerEmail} in this tenant`,
    );
  }
  if (learner.Status?.toLowerCase() === "left") {
    throw new AssignmentError(
      "learner_left",
      `${opts.learnerEmail} has left this organisation. Mark them active again before assigning a course.`,
    );
  }

  const course = await queryOne<{
    CourseId: string;
    Title: string;
    CurrentVersionId: string | null;
    NeedsSeat: boolean | number | null;
  }>(
    `SELECT CONVERT(varchar(64), c.CourseId) AS CourseId,
            c.Title,
            CONVERT(varchar(64), c.CurrentVersionId) AS CurrentVersionId,
            CAST(CASE WHEN c.TenantId = @tenantId OR ${SUBSCRIBED_IN_SCOPE}
                      THEN 0 ELSE 1 END AS bit) AS NeedsSeat
       FROM lms.Course c
      WHERE c.Slug = @slug AND ${TENANT_VISIBLE_SCOPE}`,
    { tenantId: opts.tenantId, slug: opts.courseSlug },
  );
  if (!course) {
    throw new AssignmentError(
      "course_not_found",
      `No course with slug ${opts.courseSlug} in this tenant`,
    );
  }
  if (!course.CurrentVersionId) {
    throw new AssignmentError(
      "course_not_published",
      `Course ${opts.courseSlug} has no published version to assign`,
    );
  }
  const needsSeat = Boolean(course.NeedsSeat);

  const existing = await queryOne<{
    AssignmentId: string;
    VersionId: string;
    EntitlementId: string | null;
    HoldsSeat: boolean | number | null;
  }>(
    `SELECT CONVERT(varchar(64), a.AssignmentId)  AS AssignmentId,
            CONVERT(varchar(64), a.VersionId)     AS VersionId,
            CONVERT(varchar(64), a.EntitlementId) AS EntitlementId,
            CAST(CASE WHEN EXISTS (
              SELECT 1 FROM lms.Entitlement ent
               WHERE ent.EntitlementId = a.EntitlementId
                 AND ent.TenantId = a.TenantId
                 AND ${ENTITLEMENT_LIVE}
            ) THEN 1 ELSE 0 END AS bit) AS HoldsSeat
       FROM lms.CourseAssignment a
      WHERE a.TenantId = @tenantId AND a.LearnerId = @learnerId AND a.CourseId = @courseId`,
    {
      tenantId: opts.tenantId,
      learnerId: learner.LearnerId,
      courseId: course.CourseId,
    },
  );

  const resolved = (row: { assignmentId: string; versionId: string; entitlementId: string | null }, created: boolean) => ({
    learnerId: learner.LearnerId,
    learnerEmail: learner.Email,
    learnerName: learner.DisplayName,
    courseId: course.CourseId,
    courseTitle: course.Title,
    ...row,
    created,
  });
  const update = {
    assignedBy: opts.assignedBy,
    dueDate: opts.dueDate ?? null,
    note: opts.note ?? null,
  };

  if (existing && needsSeat && !existing.HoldsSeat) {
    const moved = await retryDeadlockOnce(() => queryOne<{ EntitlementId: string }>(
      `DECLARE @moved INT;
       UPDATE a
          SET EntitlementId = seat.EntitlementId,
              AssignedBy    = @assignedBy,
              DueDate       = @dueDate,
              Note          = @note,
              Status        = 'active'
         FROM lms.CourseAssignment a
        CROSS APPLY (${FREE_SEAT}) seat
        WHERE a.AssignmentId = @assignmentId AND a.TenantId = @tenantId;
       SET @moved = @@ROWCOUNT;
       SELECT CONVERT(varchar(64), a.EntitlementId) AS EntitlementId
         FROM lms.CourseAssignment a
        WHERE @moved = 1 AND a.AssignmentId = @assignmentId AND a.TenantId = @tenantId;`,
      {
        tenantId: opts.tenantId,
        courseId: course.CourseId,
        assignmentId: existing.AssignmentId,
        ...update,
      },
    ));
    if (!moved) throw noSeats(opts.courseSlug);
    return resolved({
      assignmentId: existing.AssignmentId,
      versionId: existing.VersionId,
      entitlementId: moved.EntitlementId,
    }, false);
  }

  if (existing) {
    await execute(
      `UPDATE lms.CourseAssignment
          SET AssignedBy = @assignedBy,
              DueDate    = @dueDate,
              Note       = @note,
              Status     = 'active'
        WHERE AssignmentId = @assignmentId`,
      { assignmentId: existing.AssignmentId, ...update },
    );
    return resolved({
      assignmentId: existing.AssignmentId,
      versionId: existing.VersionId,
      entitlementId: existing.EntitlementId ?? null,
    }, false);
  }

  if (needsSeat) {
    const seated = await retryDeadlockOnce(() => queryOne<{ AssignmentId: string; VersionId: string; EntitlementId: string }>(
      `DECLARE @id UNIQUEIDENTIFIER = NEWID();
       INSERT INTO lms.CourseAssignment
         (AssignmentId, TenantId, LearnerId, CourseId, VersionId,
          AssignedBy, DueDate, Note, EntitlementId)
       SELECT @id, @tenantId, @learnerId, @courseId, seat.VersionId,
              @assignedBy, @dueDate, @note, seat.EntitlementId
         FROM (${FREE_SEAT}) seat;
       SELECT CONVERT(varchar(64), a.AssignmentId)  AS AssignmentId,
              CONVERT(varchar(64), a.VersionId)     AS VersionId,
              CONVERT(varchar(64), a.EntitlementId) AS EntitlementId
         FROM lms.CourseAssignment a
        WHERE a.AssignmentId = @id AND a.TenantId = @tenantId;`,
      {
        tenantId: opts.tenantId,
        learnerId: learner.LearnerId,
        courseId: course.CourseId,
        ...update,
      },
    ));
    if (!seated) throw noSeats(opts.courseSlug);
    return resolved({
      assignmentId: seated.AssignmentId,
      versionId: seated.VersionId,
      entitlementId: seated.EntitlementId,
    }, true);
  }

  const inserted = await queryOne<{ AssignmentId: string }>(
    `DECLARE @id UNIQUEIDENTIFIER = NEWID();
     INSERT INTO lms.CourseAssignment
       (AssignmentId, TenantId, LearnerId, CourseId, VersionId,
        AssignedBy, DueDate, Note)
     VALUES
       (@id, @tenantId, @learnerId, @courseId, @versionId,
        @assignedBy, @dueDate, @note);
     SELECT CONVERT(varchar(64), @id) AS AssignmentId;`,
    {
      tenantId: opts.tenantId,
      learnerId: learner.LearnerId,
      courseId: course.CourseId,
      versionId: course.CurrentVersionId,
      ...update,
    },
  );
  return resolved({
    assignmentId: inserted?.AssignmentId ?? "",
    versionId: course.CurrentVersionId,
    entitlementId: null,
  }, true);
}

function noSeats(courseSlug: string): AssignmentError {
  return new AssignmentError(
    "no_seats",
    `Every seat bought for ${courseSlug} is assigned. Unassign a learner or buy more seats.`,
  );
}

export async function deleteAssignment(
  tenantId: string,
  assignmentId: string,
): Promise<boolean> {
  const row = await queryOne<{ AssignmentId: string }>(
    `SELECT CONVERT(varchar(64), AssignmentId) AS AssignmentId
       FROM lms.CourseAssignment
      WHERE TenantId = @tenantId AND AssignmentId = @assignmentId`,
    { tenantId, assignmentId },
  );
  if (!row) return false;
  await execute(
    `DELETE FROM lms.CourseAssignment
      WHERE TenantId = @tenantId AND AssignmentId = @assignmentId`,
    { tenantId, assignmentId },
  );
  return true;
}

export class AssignmentError extends Error {
  constructor(
    public code:
      | "learner_not_found"
      | "learner_left"
      | "course_not_found"
      | "course_not_published"
      | "no_seats",
    message: string,
  ) {
    super(message);
    this.name = "AssignmentError";
  }
}
