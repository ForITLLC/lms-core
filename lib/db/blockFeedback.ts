import { execute, query, queryOne } from "@/lib/db";

// Per-slide feedback store. One row per (TenantId, LearnerId, BlockId);
// upsertBlockFeedback edits the note in place so a learner can revise what they
// said about a slide. Distinct from lib/db/feedback.ts, which holds the
// whole-course star rating. Every read and write is tenant-scoped — TenantId
// always comes from the session, never the request body.

export interface BlockFeedbackRow {
  BlockFeedbackId: string;
  TenantId: string;
  LearnerId: string;
  CourseId: string;
  BlockId: string;
  Comment: string;
  Resolved: boolean;
  CreatedAt: Date;
  UpdatedAt: Date;
}

export async function upsertBlockFeedback(
  tenantId: string,
  learnerId: string,
  courseId: string,
  blockId: string,
  comment: string,
): Promise<BlockFeedbackRow> {
  await execute(
    `MERGE lms.BlockFeedback AS target
     USING (SELECT @tenantId AS TenantId, @learnerId AS LearnerId, @blockId AS BlockId) AS src
       ON target.TenantId = src.TenantId
      AND target.LearnerId = src.LearnerId
      AND target.BlockId = src.BlockId
     WHEN MATCHED THEN UPDATE
       SET Comment   = @comment,
           UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (BlockFeedbackId, TenantId, LearnerId, CourseId, BlockId, Comment)
       VALUES (NEWID(), @tenantId, @learnerId, @courseId, @blockId, @comment);`,
    { tenantId, learnerId, courseId, blockId, comment },
  );
  const row = await getBlockFeedbackForLearnerBlock(tenantId, learnerId, blockId);
  if (!row) throw new Error("Block feedback upsert failed");
  return row;
}

export async function getBlockFeedbackForLearnerBlock(
  tenantId: string,
  learnerId: string,
  blockId: string,
): Promise<BlockFeedbackRow | null> {
  return await queryOne<BlockFeedbackRow>(
    `SELECT BlockFeedbackId, TenantId, LearnerId, CourseId, BlockId,
            Comment, Resolved, CreatedAt, UpdatedAt
       FROM lms.BlockFeedback
      WHERE TenantId = @tenantId
        AND LearnerId = @learnerId
        AND BlockId = @blockId`,
    { tenantId, learnerId, blockId },
  );
}

export interface BlockFeedbackEntry {
  blockFeedbackId: string;
  blockId: string;
  comment: string;
  resolved: boolean;
  createdAt: Date;
  updatedAt: Date;
  learnerDisplayName: string;
  lessonTitle: string;
  lessonOrderIndex: number;
  blockOrderIndex: number;
}

// Author read path: every per-slide note for a course, ordered the way a
// learner walks the course (lesson, then block). The admin inbox UI that
// consumes this is a follow-up; the data path ships now so feedback is never
// write-only.
export async function getBlockFeedbackForCourse(
  tenantId: string,
  courseId: string,
): Promise<BlockFeedbackEntry[]> {
  const rows = await query<{
    BlockFeedbackId: string;
    BlockId: string;
    Comment: string;
    Resolved: boolean;
    CreatedAt: Date;
    UpdatedAt: Date;
    LearnerDisplayName: string;
    LessonTitle: string;
    LessonOrderIndex: number;
    BlockOrderIndex: number;
  }>(
    `SELECT f.BlockFeedbackId, f.BlockId, f.Comment, f.Resolved,
            f.CreatedAt, f.UpdatedAt,
            l.DisplayName  AS LearnerDisplayName,
            les.Title      AS LessonTitle,
            les.OrderIndex AS LessonOrderIndex,
            b.OrderIndex   AS BlockOrderIndex
       FROM lms.BlockFeedback f
       JOIN lms.Learner l   ON l.LearnerId = f.LearnerId
       JOIN lms.Block   b   ON b.BlockId = f.BlockId
       JOIN lms.Lesson  les ON les.LessonId = b.LessonId
      WHERE f.TenantId = @tenantId
        AND f.CourseId = @courseId
      ORDER BY les.OrderIndex, b.OrderIndex, f.UpdatedAt DESC`,
    { tenantId, courseId },
  );
  return rows.map((r) => ({
    blockFeedbackId: r.BlockFeedbackId,
    blockId: r.BlockId,
    comment: r.Comment,
    resolved: r.Resolved,
    createdAt: r.CreatedAt,
    updatedAt: r.UpdatedAt,
    learnerDisplayName: r.LearnerDisplayName,
    lessonTitle: r.LessonTitle,
    lessonOrderIndex: r.LessonOrderIndex,
    blockOrderIndex: r.BlockOrderIndex,
  }));
}
