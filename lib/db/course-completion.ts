import { groupQuizQuestions } from "@/lib/db/quiz-questions";
import { query } from "@/lib/db";
import { seatHeldBy } from "@/lib/db/course-scope";

export interface CourseCompletionState {
  versionId: string | null;
  courseCompleted: boolean;
  quizzes: Array<{ quizId: string; submitted: boolean }>;
}

export async function getCourseCompletionState(
  tenantId: string,
  learnerId: string,
  courseId: string,
): Promise<CourseCompletionState | null> {
  const rows = await query<{
    VersionId: string | null;
    CompletedAt: Date | null;
    QuizId: string | null;
    Submitted: boolean | number;
    PayloadJson: string | null;
  }>(
    `WITH scoped AS (
       SELECT c.CourseId, COALESCE(e.VersionId, c.CurrentVersionId) AS VersionId,
              e.CompletedAt, e.CycleStartedAt
         FROM lms.Course c
         LEFT JOIN lms.Enrollment e
           ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
          AND e.TenantId = @tenantId
        WHERE c.CourseId = @courseId
          AND (c.TenantId = @tenantId OR EXISTS (
            SELECT 1 FROM lms.CatalogSubscription s
             WHERE s.CourseId = c.CourseId AND s.TenantId = @tenantId
          ) OR ${seatHeldBy()})
     ), quizzes AS (
       SELECT q.QuizId
         FROM scoped c
         JOIN lms.Lesson l ON l.CourseId = c.CourseId AND l.VersionId = c.VersionId
         JOIN lms.Block b ON b.LessonId = l.LessonId AND b.VersionId = c.VersionId
         JOIN lms.Quiz q ON q.BlockId = b.BlockId
     )
     SELECT CONVERT(varchar(64), c.VersionId) AS VersionId, c.CompletedAt,
            CONVERT(varchar(64), q.QuizId) AS QuizId,
            CAST(CASE WHEN EXISTS (
              SELECT 1 FROM lms.QuizAttempt a
               WHERE a.QuizId = q.QuizId AND a.LearnerId = @learnerId
                 AND a.SubmittedAt IS NOT NULL
                 AND (c.CycleStartedAt IS NULL OR a.SubmittedAt >= c.CycleStartedAt)
            ) THEN 1 ELSE 0 END AS bit) AS Submitted, qq.PayloadJson
       FROM scoped c LEFT JOIN quizzes q ON 1 = 1
       LEFT JOIN lms.QuizQuestion qq ON qq.QuizId = q.QuizId`,
    { tenantId, learnerId, courseId },
  );
  const first = rows[0];
  if (!first) return null;
  const questions = groupQuizQuestions(rows.flatMap((row) =>
    row.QuizId !== null && row.PayloadJson !== null
      ? [{ QuizId: row.QuizId, PayloadJson: row.PayloadJson }] : []));
  const quizzes = new Map(rows.flatMap((row) =>
    row.QuizId !== null && questions.has(row.QuizId.toLowerCase())
      ? [[row.QuizId.toLowerCase(), Boolean(row.Submitted)] as const] : []));
  return {
    versionId: first.VersionId,
    courseCompleted: first.CompletedAt !== null,
    quizzes: [...quizzes].map(([quizId, submitted]) => ({ quizId, submitted })),
  };
}
