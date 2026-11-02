import { execute, query, queryOne } from "@/lib/db";

// Course-rating store. One feedback row per (TenantId, LearnerId, CourseId);
// upsertCourseFeedback edits in place so a learner can revise. Every read and
// write is tenant-scoped — TenantId always comes from the session, never the
// request body.

export interface CourseFeedbackRow {
  FeedbackId: string;
  TenantId: string;
  LearnerId: string;
  CourseId: string;
  Rating: number;
  Comment: string | null;
  SubmittedAt: Date;
  UpdatedAt: Date;
}

export async function upsertCourseFeedback(
  tenantId: string,
  learnerId: string,
  courseId: string,
  rating: number,
  comment: string | null,
): Promise<CourseFeedbackRow> {
  await execute(
    `MERGE lms.CourseFeedback AS target
     USING (SELECT @tenantId AS TenantId, @learnerId AS LearnerId, @courseId AS CourseId) AS src
       ON target.TenantId = src.TenantId
      AND target.LearnerId = src.LearnerId
      AND target.CourseId = src.CourseId
     WHEN MATCHED THEN UPDATE
       SET Rating    = @rating,
           Comment   = @comment,
           UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (FeedbackId, TenantId, LearnerId, CourseId, Rating, Comment)
       VALUES (NEWID(), @tenantId, @learnerId, @courseId, @rating, @comment);`,
    { tenantId, learnerId, courseId, rating, comment },
  );
  const row = await getCourseFeedbackForLearner(tenantId, learnerId, courseId);
  if (!row) throw new Error("Feedback upsert failed");
  return row;
}

export async function getCourseFeedbackForLearner(
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<CourseFeedbackRow | null> {
  return await queryOne<CourseFeedbackRow>(
    `SELECT FeedbackId, TenantId, LearnerId, CourseId, Rating, Comment, SubmittedAt, UpdatedAt
       FROM lms.CourseFeedback
      WHERE TenantId = @tenantId
        AND LearnerId = @learnerId
        AND CourseId = @courseId`,
    { tenantId, learnerId, courseId },
  );
}

export interface CourseFeedbackComment {
  rating: number;
  comment: string | null;
  submittedAt: Date;
  learnerDisplayName: string;
}

export interface CourseFeedbackSummary {
  avgRating: number | null;
  count: number;
  recent: CourseFeedbackComment[];
}

export async function getCourseFeedbackSummary(
  tenantId: string,
  courseId: string,
): Promise<CourseFeedbackSummary> {
  const agg = await queryOne<{ AvgRating: number | null; Cnt: number }>(
    `SELECT AVG(CAST(Rating AS DECIMAL(5,2))) AS AvgRating,
            COUNT(*) AS Cnt
       FROM lms.CourseFeedback
      WHERE TenantId = @tenantId AND CourseId = @courseId`,
    { tenantId, courseId },
  );

  const recentRows = await query<{
    Rating: number;
    Comment: string | null;
    SubmittedAt: Date;
    LearnerDisplayName: string;
  }>(
    `SELECT TOP 10 f.Rating, f.Comment, f.SubmittedAt, l.DisplayName AS LearnerDisplayName
       FROM lms.CourseFeedback f
       JOIN lms.Learner l ON l.LearnerId = f.LearnerId
      WHERE f.TenantId = @tenantId
        AND f.CourseId = @courseId
        AND f.Comment IS NOT NULL
        AND LEN(LTRIM(RTRIM(f.Comment))) > 0
      ORDER BY f.UpdatedAt DESC`,
    { tenantId, courseId },
  );

  return {
    avgRating: agg?.AvgRating ?? null,
    count: agg?.Cnt ?? 0,
    recent: recentRows.map((r) => ({
      rating: r.Rating,
      comment: r.Comment,
      submittedAt: r.SubmittedAt,
      learnerDisplayName: r.LearnerDisplayName,
    })),
  };
}
