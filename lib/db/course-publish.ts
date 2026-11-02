import { randomUUID } from "node:crypto";
import { queryOne } from "@/lib/db";
import { getDraft, type DraftRef } from "@/lib/db/course-drafts";
import { buildPublishPlan } from "@/lib/builder/publish-plan";
import type { PublishProblem } from "@/lib/schema/draft";

export type PublishResult =
  | { ok: true; versionId: string; versionNumber: number }
  | { ok: false; reason: "not_found" | "draft_conflict" | "base_moved" }
  | { ok: false; reason: "not_publishable"; problems: PublishProblem[] };

// Turns a draft into the course's next version in one transaction: lock the
// course and its draft, check it is still the draft and revision the author
// published from and still based on the live version, insert the version and
// fresh content rows, then point the course at it and drop the draft.
// Published lessons, blocks and quizzes are never updated or deleted, so a
// learner pinned to an older version keeps it.
const PUBLISH = `
SET XACT_ABORT ON;
SET NOCOUNT ON;
BEGIN TRANSACTION;

DECLARE @courseFound BIT = 0, @current UNIQUEIDENTIFIER, @base UNIQUEIDENTIFIER,
        @draftFound UNIQUEIDENTIFIER, @draftRevision INT, @versionNumber INT, @outcome VARCHAR(16);

SELECT @courseFound = 1, @current = c.CurrentVersionId
  FROM lms.Course c WITH (UPDLOCK, HOLDLOCK)
 WHERE c.TenantId = @tenantId AND c.CourseId = @courseId;

SELECT @draftFound = d.DraftId, @draftRevision = d.Revision, @base = d.BaseVersionId
  FROM lms.CourseDraft d WITH (UPDLOCK, HOLDLOCK)
 WHERE d.TenantId = @tenantId AND d.CourseId = @courseId;

SET @outcome = CASE
  WHEN @courseFound = 0 THEN 'not_found'
  WHEN @draftFound IS NULL OR @draftFound <> @draftId OR @draftRevision <> @revision THEN 'draft_conflict'
  WHEN EXISTS (SELECT @base EXCEPT SELECT @current) THEN 'base_moved'
  ELSE 'published' END;

IF @outcome = 'published'
BEGIN
  SELECT @versionNumber = ISNULL(MAX(v.VersionNumber), 0) + 1
    FROM lms.CourseVersion v WITH (UPDLOCK, HOLDLOCK)
   WHERE v.CourseId = @courseId;

  INSERT INTO lms.CourseVersion (VersionId, CourseId, VersionNumber, PublishedBy, ChangeNote)
  VALUES (@versionId, @courseId, @versionNumber, @by, @changeNote);

  INSERT INTO lms.Lesson (LessonId, CourseId, VersionId, Title, OrderIndex, EstMinutes)
  SELECT j.LessonId, @courseId, @versionId, j.Title, j.OrderIndex, j.EstMinutes
    FROM OPENJSON(@rows, '$.lessons')
         WITH (LessonId UNIQUEIDENTIFIER, Title NVARCHAR(256), OrderIndex INT, EstMinutes INT) j;

  INSERT INTO lms.Block (BlockId, LessonId, VersionId, Kind, OrderIndex, PayloadJson)
  SELECT j.BlockId, j.LessonId, @versionId, j.Kind, j.OrderIndex, j.PayloadJson
    FROM OPENJSON(@rows, '$.blocks')
         WITH (BlockId UNIQUEIDENTIFIER, LessonId UNIQUEIDENTIFIER, Kind NVARCHAR(32),
               OrderIndex INT, PayloadJson NVARCHAR(MAX)) j;

  INSERT INTO lms.Quiz (QuizId, BlockId, VersionId, PassingScore, IsExam)
  SELECT j.QuizId, j.BlockId, @versionId, j.PassingScore, j.IsExam
    FROM OPENJSON(@rows, '$.quizzes')
         WITH (QuizId UNIQUEIDENTIFIER, BlockId UNIQUEIDENTIFIER, PassingScore INT, IsExam BIT) j;

  INSERT INTO lms.QuizQuestion (QuestionId, QuizId, VersionId, Kind, OrderIndex, PromptMd, PayloadJson)
  SELECT j.QuestionId, j.QuizId, @versionId, j.Kind, j.OrderIndex, j.PromptMd, j.PayloadJson
    FROM OPENJSON(@rows, '$.questions')
         WITH (QuestionId UNIQUEIDENTIFIER, QuizId UNIQUEIDENTIFIER, Kind NVARCHAR(32), OrderIndex INT,
               PromptMd NVARCHAR(MAX), PayloadJson NVARCHAR(MAX)) j;

  UPDATE lms.Course
     SET Title = @title, Description = @description, Category = @category, Tags = @tags,
         ScheduleKind = @scheduleKind, RecurrenceMonths = @recurrenceMonths,
         RequiresQuizPass = @requiresQuizPass,
         Status = CASE WHEN Status = 'draft' THEN 'published' ELSE Status END,
         UpdatedAt = SYSUTCDATETIME(),
         CurrentVersionId = @versionId
   WHERE TenantId = @tenantId AND CourseId = @courseId;

  DELETE FROM lms.CourseDraft WHERE TenantId = @tenantId AND CourseId = @courseId;

  INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
  VALUES (NEWID(), @tenantId, @by, 'course.publish', 'course', LOWER(CONVERT(varchar(36), @courseId)),
          CONCAT('{"versionId":"', LOWER(CONVERT(varchar(36), @versionId)), '","versionNumber":', @versionNumber,
                 ',"draftRevision":', @revision, '}'));
END;

COMMIT TRANSACTION;
SELECT @outcome AS Outcome, @versionNumber AS VersionNumber;
`;

export async function publishDraft(
  tenantId: string,
  courseId: string,
  by: string,
  { draftId, revision }: DraftRef,
  changeNote?: string | null,
): Promise<PublishResult> {
  const draft = await getDraft(tenantId, courseId);
  if (!draft) return { ok: false, reason: "not_found" };
  if (draft.draftId !== draftId || draft.revision !== revision) return { ok: false, reason: "draft_conflict" };
  const planned = buildPublishPlan(draft.doc);
  if (!planned.ok) return { ok: false, reason: "not_publishable", problems: planned.problems };

  const { course, rows } = planned.plan;
  const versionId = randomUUID();
  const result = await queryOne<{ Outcome: string; VersionNumber: number | null }>(PUBLISH, {
    tenantId,
    courseId,
    draftId,
    revision,
    versionId,
    by,
    changeNote: changeNote?.trim() ? changeNote.trim().slice(0, 1024) : null,
    rows: JSON.stringify(rows),
    title: course.title,
    description: course.description,
    category: course.category,
    tags: course.tags,
    scheduleKind: course.scheduleKind,
    recurrenceMonths: course.recurrenceMonths,
    requiresQuizPass: course.requiresQuizPass,
  });
  switch (result?.Outcome) {
    case "published":
      return { ok: true, versionId, versionNumber: result.VersionNumber ?? 0 };
    case "not_found":
    case "draft_conflict":
    case "base_moved":
      return { ok: false, reason: result.Outcome };
    default:
      throw new Error(`publishDraft: unexpected outcome ${String(result?.Outcome)}`);
  }
}
