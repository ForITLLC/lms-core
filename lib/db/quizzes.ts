import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { seatHeldBy } from "@/lib/db/course-scope";
import { QuizQuestion } from "@/lib/schema/quiz";

// M4 scoring engine. The attempt/answer tables and per-quiz PassingScore exist
// from migration 0001; this module is the wire-up: load a quiz's questions
// (with answer keys) scoped to the caller's tenant, grade a learner's
// responses deterministically, persist the attempt, and roll quizzes up into a
// per-course pass/fail gate the completion endpoint enforces.

export interface GradableQuestion {
  questionId: string;
  orderIndex: number;
  question: QuizQuestion;
}

export interface QuizForGrading {
  quizId: string;
  courseId: string;
  passingScore: number;
  questions: GradableQuestion[];
}

// Loads a quiz for grading ONLY if it belongs to the named course AND that
// course is open to the learner (own course, subscribed catalogue course, or
// an entitled course whose seat the learner holds; learnerId null admits no
// entitled course). Tenant scoping is mandatory — a forged quizId from another
// tenant resolves to null. Returns answer keys, so this is strictly server-side.
export async function getQuizForGrading(
  tenantId: string,
  learnerId: string | null,
  courseId: string,
  quizId: string,
): Promise<QuizForGrading | null> {
  const meta = await queryOne<{
    QuizId: string;
    CourseId: string;
    PassingScore: number;
  }>(
    `SELECT TOP 1
            CONVERT(varchar(64), q.QuizId)   AS QuizId,
            CONVERT(varchar(64), c.CourseId) AS CourseId,
            q.PassingScore
       FROM lms.Quiz q
       JOIN lms.Block  b ON b.BlockId  = q.BlockId
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
       JOIN lms.Course c ON c.CourseId = l.CourseId
      WHERE q.QuizId = @quizId
        AND c.CourseId = @courseId
        AND (
              c.TenantId = @tenantId
              OR c.CourseId IN (SELECT CourseId FROM lms.CatalogSubscription
                                 WHERE TenantId = @tenantId)
              OR ${seatHeldBy()}
            )`,
    { tenantId, learnerId, courseId, quizId },
  );
  if (!meta) return null;

  const rows = await query<{
    QuestionId: string;
    OrderIndex: number;
    PayloadJson: string;
  }>(
    `SELECT CONVERT(varchar(64), QuestionId) AS QuestionId, OrderIndex, PayloadJson
       FROM lms.QuizQuestion
      WHERE QuizId = @quizId
      ORDER BY OrderIndex ASC`,
    { quizId },
  );
  const questions: GradableQuestion[] = [];
  for (const row of rows) {
    const parsed = QuizQuestion.safeParse(JSON.parse(row.PayloadJson));
    if (!parsed.success) continue;
    questions.push({
      questionId: row.QuestionId,
      orderIndex: row.OrderIndex,
      question: parsed.data,
    });
  }
  return {
    quizId: meta.QuizId,
    courseId: meta.CourseId,
    passingScore: meta.PassingScore,
    questions,
  };
}

export type QuizResponse = string | boolean | string[] | null;

export interface GradedQuestion {
  questionId: string;
  orderIndex: number;
  autoGradable: boolean;
  correct: boolean | null; // null = needs manual grading (short answer)
}

export interface GradeResult {
  score: number; // 0–100 over auto-gradable questions
  autoGradableCount: number;
  correctCount: number;
  perQuestion: GradedQuestion[];
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

// Deterministic grader. Responses are positional — responses[orderIndex]
// answers the question at that index. mcq/confidence/tf/multi are auto-graded;
// short answers are recorded but not auto-scored (correct=null) and excluded
// from the denominator so a short-answer-only quiz never silently auto-passes.
export function gradeResponses(
  questions: GradableQuestion[],
  responses: QuizResponse[],
): GradeResult {
  const perQuestion: GradedQuestion[] = [];
  let autoGradableCount = 0;
  let correctCount = 0;
  for (const gq of questions) {
    const resp = responses[gq.orderIndex] ?? null;
    const q = gq.question;
    let correct: boolean | null = null;
    let auto = true;
    switch (q.kind) {
      case "mcq":
      case "confidence":
        correct = typeof resp === "string" && resp === q.correctChoiceId;
        break;
      case "tf":
        correct = typeof resp === "boolean" && resp === q.correctValue;
        break;
      case "multi":
        correct = Array.isArray(resp) && setsEqual(resp, q.correctChoiceIds);
        break;
      case "short":
        auto = false;
        correct = null;
        break;
    }
    if (auto) {
      autoGradableCount += 1;
      if (correct) correctCount += 1;
    }
    perQuestion.push({
      questionId: gq.questionId,
      orderIndex: gq.orderIndex,
      autoGradable: auto,
      correct,
    });
  }
  const score =
    autoGradableCount > 0 ? Math.round((correctCount / autoGradableCount) * 100) : 0;
  return { score, autoGradableCount, correctCount, perQuestion };
}

export interface RecordedAttempt {
  attemptId: string;
  score: number;
  passingScore: number;
  passed: boolean;
}

// Persists one graded attempt: a QuizAttempt row plus an AnswerResponse row per
// question. MachineScore is 1/0 for auto-graded questions and NULL for short
// answers (flagged for later manual / AI grading).
export async function recordAttempt(
  quizId: string,
  learnerId: string,
  passingScore: number,
  questions: GradableQuestion[],
  responses: QuizResponse[],
  grade: GradeResult,
): Promise<RecordedAttempt> {
  const attemptId = randomUUID();
  await execute(
    `INSERT INTO lms.QuizAttempt (AttemptId, QuizId, LearnerId, Score, SubmittedAt)
     VALUES (@attemptId, @quizId, @learnerId, @score, SYSUTCDATETIME())`,
    { attemptId, quizId, learnerId, score: grade.score },
  );
  const byIndex = new Map(grade.perQuestion.map((p) => [p.orderIndex, p]));
  for (const gq of questions) {
    const p = byIndex.get(gq.orderIndex);
    const resp = responses[gq.orderIndex] ?? null;
    const machineScore = !p || p.correct === null ? null : p.correct ? 1 : 0;
    await execute(
      `INSERT INTO lms.AnswerResponse (AttemptId, QuestionId, ResponseJson, MachineScore)
       VALUES (@attemptId, @questionId, @responseJson, @machineScore)`,
      {
        attemptId,
        questionId: gq.questionId,
        responseJson: JSON.stringify(resp),
        machineScore,
      },
    );
  }
  return {
    attemptId,
    score: grade.score,
    passingScore,
    passed: grade.score >= passingScore,
  };
}

export interface CourseQuizGate {
  totalQuizzes: number;
  passedQuizzes: number;
  passed: boolean;
  quizzes: Array<{
    quizId: string;
    passingScore: number;
    bestScore: number | null;
    passed: boolean;
  }>;
}

// Version-aware pass roll-up: for each quiz in the learner's pinned course
// version, their best score submitted in the current cycle and whether it
// clears PassingScore.
// `passed` is true only when every quiz is cleared (a course with no quizzes
// is vacuously passed).
export async function getCourseQuizGate(
  learnerId: string,
  courseId: string,
): Promise<CourseQuizGate> {
  const rows = await query<{
    QuizId: string;
    PassingScore: number;
    BestScore: number | null;
  }>(
    `WITH pinned AS (
       SELECT COALESCE(e.VersionId, c.CurrentVersionId) AS VersionId,
              e.CycleStartedAt
         FROM lms.Course c
         LEFT JOIN lms.Enrollment e
           ON e.CourseId = c.CourseId AND e.LearnerId = @learnerId
        WHERE c.CourseId = @courseId
     )
     SELECT CONVERT(varchar(64), q.QuizId) AS QuizId,
            q.PassingScore,
            (SELECT MAX(a.Score) FROM lms.QuizAttempt a CROSS JOIN pinned p
              WHERE a.QuizId = q.QuizId
                AND a.LearnerId = @learnerId
                AND a.SubmittedAt IS NOT NULL
                AND (p.CycleStartedAt IS NULL OR a.SubmittedAt >= p.CycleStartedAt)) AS BestScore
       FROM lms.Quiz q
       JOIN lms.Block  b ON b.BlockId  = q.BlockId
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
      WHERE l.CourseId = @courseId
        AND b.VersionId = (SELECT VersionId FROM pinned)`,
    { learnerId, courseId },
  );
  const quizzes = rows.map((r) => ({
    quizId: r.QuizId,
    passingScore: r.PassingScore,
    bestScore: r.BestScore,
    passed: r.BestScore !== null && r.BestScore >= r.PassingScore,
  }));
  return {
    totalQuizzes: quizzes.length,
    passedQuizzes: quizzes.filter((q) => q.passed).length,
    passed: quizzes.every((q) => q.passed),
    quizzes,
  };
}

// Reads lms.Course.RequiresQuizPass, tolerant of the column not existing yet
// (pre-0015) so the completion endpoint never hard-fails on an un-migrated DB.
export async function courseRequiresQuizPass(courseId: string): Promise<boolean> {
  const row = await queryOne<{ RequiresQuizPass: boolean | number }>(
    `IF COL_LENGTH('lms.Course', 'RequiresQuizPass') IS NULL
       SELECT CAST(0 AS BIT) AS RequiresQuizPass
     ELSE
       EXEC sp_executesql
         N'SELECT RequiresQuizPass FROM lms.Course WHERE CourseId = @c',
         N'@c uniqueidentifier', @c = @courseId`,
    { courseId },
  );
  return !!row?.RequiresQuizPass;
}
