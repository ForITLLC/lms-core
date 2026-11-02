import { randomUUID } from "node:crypto";
import { execute, query, queryOne } from "@/lib/db";
import { QuizQuestion } from "@/lib/schema/quiz";
import type { GradeRecord, GradeSource } from "@/lib/ai/grading/score";

// Marks for written answers and the AI marking queue (migration 0032;
// docs/plans/2026-10-29-ai-authoring.md, slice A5a).
//
// lms.QuizAttempt has no TenantId: an attempt is its learner's tenant's, so
// every statement that reaches an attempt joins lms.Learner on that tenant.
// lms.AnswerGrade is append-only. Nothing here updates or deletes a mark; an
// instructor's mark is a new row that wins over the AI's. Each append writes
// the attempt's pass/fail score (lms.QuizAttempt.Score) in the same
// transaction, and only if the attempt's marks are still the ones the score
// was worked out from.

export const GRADING_LEASE_SECONDS = 180;

export interface AttemptRecord {
  attemptId: string;
  quizId: string;
  passingScore: number;
  storedScore: number | null;
  answers: Array<{
    questionId: string;
    orderIndex: number;
    machineScore: number | null;
    question: QuizQuestion | null;
    responseJson: string;
  }>;
  grades: GradeRecord[];
}

interface AnswerRow {
  AttemptId: string;
  QuizId: string;
  PassingScore: number;
  Score: number | null;
  QuestionId: string;
  OrderIndex: number;
  MachineScore: number | null;
  PayloadJson: string;
  ResponseJson: string;
}

interface GradeRow {
  GradeId: string;
  QuestionId: string;
  Seq: number;
  Source: GradeSource;
  Score: number;
  MaxScore: number;
  FeedbackMd: string | null;
  Model: string | null;
  PromptVersion: string | null;
  GradedBy: string | null;
  GradedAt: Date;
  Reason: string | null;
  ConfirmsGradeId: string | null;
}

const lower = (id: string) => id.toLowerCase();

function parseQuestion(json: string): QuizQuestion | null {
  try {
    const parsed = QuizQuestion.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function toGrade(row: GradeRow): GradeRecord {
  return {
    gradeId: lower(row.GradeId),
    questionId: lower(row.QuestionId),
    seq: row.Seq,
    source: row.Source,
    score: row.Score,
    maxScore: row.MaxScore,
    feedbackMd: row.FeedbackMd,
    model: row.Model,
    promptVersion: row.PromptVersion,
    gradedBy: row.GradedBy,
    gradedAt: row.GradedAt,
    reason: row.Reason,
    confirmsGradeId: row.ConfirmsGradeId ? lower(row.ConfirmsGradeId) : null,
  };
}

// One attempt of the tenant's own learner: every answer with its question and
// every mark in the order they were made. Null for another tenant's attempt.
export async function readAttempt(tenantId: string, attemptId: string): Promise<AttemptRecord | null> {
  return readAttemptWhere(tenantId, attemptId, null);
}

// The same, only if the attempt is the signed-in learner's own (lms.Learner is
// one row per tenant and email). Null for anyone else's.
export async function readOwnAttempt(tenantId: string, learnerEmail: string, attemptId: string): Promise<AttemptRecord | null> {
  return readAttemptWhere(tenantId, attemptId, learnerEmail);
}

async function readAttemptWhere(tenantId: string, attemptId: string, learnerEmail: string | null): Promise<AttemptRecord | null> {
  const rows = await query<AnswerRow>(
    `SELECT CONVERT(varchar(36), a.AttemptId) AS AttemptId, CONVERT(varchar(36), a.QuizId) AS QuizId,
            q.PassingScore, a.Score, CONVERT(varchar(36), r.QuestionId) AS QuestionId, qq.OrderIndex,
            r.MachineScore, qq.PayloadJson, r.ResponseJson
       FROM lms.QuizAttempt a
       JOIN lms.Learner l ON l.LearnerId = a.LearnerId
       JOIN lms.Quiz q ON q.QuizId = a.QuizId
       JOIN lms.AnswerResponse r ON r.AttemptId = a.AttemptId
       JOIN lms.QuizQuestion qq ON qq.QuestionId = r.QuestionId
      WHERE a.AttemptId = @attemptId AND l.TenantId = @tenantId${learnerEmail === null ? "" : " AND l.Email = @learnerEmail"}
      ORDER BY qq.OrderIndex`,
    learnerEmail === null ? { attemptId, tenantId } : { attemptId, tenantId, learnerEmail },
  );
  const first = rows[0];
  if (!first) return null;
  const grades = await query<GradeRow>(
    `SELECT CONVERT(varchar(36), GradeId) AS GradeId, CONVERT(varchar(36), QuestionId) AS QuestionId, Seq, Source,
            Score, MaxScore, FeedbackMd, Model, PromptVersion, GradedBy, GradedAt, Reason,
            CONVERT(varchar(36), ConfirmsGradeId) AS ConfirmsGradeId
       FROM lms.AnswerGrade
      WHERE TenantId = @tenantId AND AttemptId = @attemptId
      ORDER BY Seq`,
    { tenantId, attemptId },
  );
  return {
    attemptId: lower(first.AttemptId),
    quizId: lower(first.QuizId),
    passingScore: first.PassingScore,
    storedScore: first.Score,
    answers: rows.map((row) => ({
      questionId: lower(row.QuestionId),
      orderIndex: row.OrderIndex,
      machineScore: row.MachineScore,
      question: parseQuestion(row.PayloadJson),
      responseJson: row.ResponseJson,
    })),
    grades: grades.map(toGrade),
  };
}

export interface NewGrade {
  gradeId: string;
  questionId: string;
  score: number;
  maxScore: number;
  feedbackMd: string | null;
}

// What both appends take besides the mark: how many marks the attempt had
// when the new score was worked out, and that score.
export interface AppendBasis {
  attemptId: string;
  seen: number;
  attemptScore: number;
}

export type AppendOutcome = "appended" | "changed" | "not_found" | "lease_lost";

export type InstructorVerb = "quiz.grade.override" | "quiz.grade.confirm";

// The attempt row's update lock queues appends to one attempt behind each
// other; a writer that finds more marks than it read appends nothing and
// answers "changed", so it can read again and work the score out afresh.
const ATTEMPT_HELD = `EXISTS (SELECT 1 FROM lms.QuizAttempt a WITH (UPDLOCK, HOLDLOCK)
                               JOIN lms.Learner l ON l.LearnerId = a.LearnerId
                              WHERE a.AttemptId = @attemptId AND l.TenantId = @tenantId)`;
const MARKS_UNCHANGED = `(SELECT COUNT(*) FROM lms.AnswerGrade WHERE TenantId = @tenantId AND AttemptId = @attemptId) = @seen`;
const SET_ATTEMPT_SCORE = `UPDATE a SET Score = @attemptScore
          FROM lms.QuizAttempt a
          JOIN lms.Learner l ON l.LearnerId = a.LearnerId
         WHERE a.AttemptId = @attemptId AND l.TenantId = @tenantId;`;

// An instructor's mark also answers any open review request on that answer
// (migration 0033): resolved here rather than by comparing RequestedAt with
// GradedAt, so "open" never rests on two timestamps, and the request names the
// mark that answered it.
export async function appendInstructorGrade(
  tenantId: string,
  basis: AppendBasis,
  grade: NewGrade & { gradedBy: string; reason: string | null; confirmsGradeId: string | null },
  audit: { verb: InstructorVerb; metaJson: string },
): Promise<AppendOutcome> {
  const row = await queryOne<{ Outcome: AppendOutcome }>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @outcome nvarchar(16) = N'not_found';
     IF ${ATTEMPT_HELD}
     BEGIN
       SET @outcome = N'changed';
       IF ${MARKS_UNCHANGED}
       BEGIN
         INSERT INTO lms.AnswerGrade (GradeId, TenantId, AttemptId, QuestionId, Seq, Source, Score, MaxScore,
                                      FeedbackMd, GradedBy, Reason, ConfirmsGradeId)
         VALUES (@gradeId, @tenantId, @attemptId, @questionId, @seen + 1, 'instructor', @score, @maxScore,
                 @feedbackMd, @gradedBy, @reason, @confirmsGradeId);
         ${SET_ATTEMPT_SCORE}
         UPDATE lms.AnswerReviewRequest SET ResolvedByGradeId = @gradeId
          WHERE TenantId = @tenantId AND AttemptId = @attemptId AND QuestionId = @questionId AND ResolvedByGradeId IS NULL;
         INSERT INTO lms.AuditEvent (EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson)
         VALUES (NEWID(), @tenantId, @gradedBy, @verb, 'quiz_attempt', LOWER(CONVERT(varchar(36), @attemptId)), @meta);
         SET @outcome = N'appended';
       END
     END
     COMMIT TRANSACTION;
     SELECT @outcome AS Outcome;`,
    {
      tenantId,
      attemptId: basis.attemptId,
      seen: basis.seen,
      attemptScore: basis.attemptScore,
      gradeId: grade.gradeId,
      questionId: grade.questionId,
      score: grade.score,
      maxScore: grade.maxScore,
      feedbackMd: grade.feedbackMd,
      gradedBy: grade.gradedBy,
      reason: grade.reason,
      confirmsGradeId: grade.confirmsGradeId,
      verb: audit.verb,
      meta: audit.metaJson,
    },
  );
  return row?.Outcome ?? "not_found";
}

// ---- the AI marking queue ----------------------------------------------------

export interface ClaimedGradingJob {
  jobId: string;
  tenantId: string;
  attemptId: string;
  questionId: string;
  attempts: number;
  usageJson: string | null;
  leaseToken: string;
}

interface ClaimRow {
  JobId: string;
  TenantId: string;
  AttemptId: string;
  QuestionId: string;
  Attempts: number;
  UsageJson: string | null;
}

// Every write a worker makes after its claim: its own job, in its tenant,
// still running under its token.
const HELD = `JobId = @jobId AND TenantId = @tenantId AND LeaseToken = @leaseToken AND Status = 'running'`;

function held(job: ClaimedGradingJob) {
  return { jobId: job.jobId, tenantId: job.tenantId, leaseToken: job.leaseToken };
}

// The AI's mark, the attempt's score and the job's completion are one
// transaction, so a mark is never paid for twice by a retry or left without
// its job finished.
export async function appendAiGrade(
  job: ClaimedGradingJob,
  basis: AppendBasis,
  grade: NewGrade & { model: string; promptVersion: string },
  usageJson: string,
): Promise<AppendOutcome> {
  const row = await queryOne<{ Outcome: AppendOutcome }>(
    `SET XACT_ABORT ON;
     BEGIN TRANSACTION;
     DECLARE @outcome nvarchar(16) = N'lease_lost';
     IF EXISTS (SELECT 1 FROM lms.AnswerGradingJob WITH (UPDLOCK, HOLDLOCK) WHERE ${HELD})
     BEGIN
       SET @outcome = N'not_found';
       IF ${ATTEMPT_HELD}
       BEGIN
         SET @outcome = N'changed';
         IF ${MARKS_UNCHANGED}
         BEGIN
           INSERT INTO lms.AnswerGrade (GradeId, TenantId, AttemptId, QuestionId, Seq, Source, Score, MaxScore,
                                        FeedbackMd, Model, PromptVersion)
           VALUES (@gradeId, @tenantId, @attemptId, @questionId, @seen + 1, 'ai', @score, @maxScore,
                   @feedbackMd, @model, @promptVersion);
           ${SET_ATTEMPT_SCORE}
           UPDATE lms.AnswerGradingJob
              SET Status = 'completed', ResultGradeId = @gradeId, ErrorMessage = NULL, UsageJson = @usage,
                  LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
            WHERE ${HELD};
           SET @outcome = N'appended';
         END
       END
     END
     COMMIT TRANSACTION;
     SELECT @outcome AS Outcome;`,
    {
      ...held(job),
      attemptId: basis.attemptId,
      seen: basis.seen,
      attemptScore: basis.attemptScore,
      gradeId: grade.gradeId,
      questionId: grade.questionId,
      score: grade.score,
      maxScore: grade.maxScore,
      feedbackMd: grade.feedbackMd,
      model: grade.model,
      promptVersion: grade.promptVersion,
      usage: usageJson,
    },
  );
  return row?.Outcome ?? "lease_lost";
}

// One job per written answer; asking twice queues nothing more. Only an answer
// of an attempt of the tenant's own learner can be queued.
export async function enqueueGradingJob(tenantId: string, attemptId: string, questionId: string): Promise<boolean> {
  const rows = await execute(
    `INSERT INTO lms.AnswerGradingJob (JobId, TenantId, AttemptId, QuestionId)
     SELECT @jobId, @tenantId, r.AttemptId, r.QuestionId
       FROM lms.AnswerResponse r
       JOIN lms.QuizAttempt a ON a.AttemptId = r.AttemptId
       JOIN lms.Learner l ON l.LearnerId = a.LearnerId
      WHERE r.AttemptId = @attemptId AND r.QuestionId = @questionId AND l.TenantId = @tenantId
        AND NOT EXISTS (SELECT 1 FROM lms.AnswerGradingJob j
                         WHERE j.TenantId = @tenantId AND j.AttemptId = @attemptId AND j.QuestionId = @questionId)`,
    { jobId: randomUUID(), tenantId, attemptId, questionId },
  );
  return rows === 1;
}

// The next job of any tenant: queued and due, or running under a lease that
// ran out. Like claimNextIngestion, this is the one statement that spans
// tenants, by design: the worker is not a tenant session, and everything it
// does after the claim names the claimed row's TenantId.
export async function claimNextGradingJob(leaseSeconds = GRADING_LEASE_SECONDS): Promise<ClaimedGradingJob | null> {
  const leaseToken = randomUUID();
  const row = await queryOne<ClaimRow>(
    `WITH next AS (
       SELECT TOP (1) *
         FROM lms.AnswerGradingJob WITH (UPDLOCK, READPAST, ROWLOCK)
        WHERE ((Status = 'queued' AND NotBefore <= SYSUTCDATETIME())
               OR (Status = 'running' AND LeaseUntil < SYSUTCDATETIME()))
        ORDER BY NotBefore, CreatedAt
     )
     UPDATE next
        SET Status = 'running', Attempts = Attempts + 1, LeaseToken = @leaseToken,
            LeaseUntil = DATEADD(second, @leaseSeconds, SYSUTCDATETIME()), UpdatedAt = SYSUTCDATETIME()
     OUTPUT CONVERT(varchar(36), inserted.JobId) AS JobId, CONVERT(varchar(36), inserted.TenantId) AS TenantId,
            CONVERT(varchar(36), inserted.AttemptId) AS AttemptId, CONVERT(varchar(36), inserted.QuestionId) AS QuestionId,
            inserted.Attempts, inserted.UsageJson`,
    { leaseToken, leaseSeconds },
  );
  if (!row) return null;
  return {
    jobId: lower(row.JobId),
    tenantId: lower(row.TenantId),
    attemptId: lower(row.AttemptId),
    questionId: lower(row.QuestionId),
    attempts: row.Attempts,
    usageJson: row.UsageJson,
    leaseToken,
  };
}

// Finished without a new mark: the answer already had one.
export async function completeGradingJob(job: ClaimedGradingJob, gradeId: string | null, usageJson: string): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AnswerGradingJob
        SET Status = 'completed', ResultGradeId = @gradeId, ErrorMessage = NULL, UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD}`,
    { ...held(job), gradeId, usage: usageJson },
  );
  return rows === 1;
}

// Failed or cancelled, the answer simply waits for an instructor.
export async function endGradingJob(
  job: ClaimedGradingJob,
  status: "failed" | "cancelled",
  message: string,
  usageJson: string,
): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AnswerGradingJob
        SET Status = @status, ErrorMessage = @message, UsageJson = @usage,
            LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD}`,
    { ...held(job), status, message: message.slice(0, 4000), usage: usageJson },
  );
  return rows === 1;
}

export async function requeueGradingJob(
  job: ClaimedGradingJob,
  delaySeconds: number,
  message: string,
  usageJson: string,
): Promise<boolean> {
  const rows = await execute(
    `UPDATE lms.AnswerGradingJob
        SET Status = 'queued', NotBefore = DATEADD(second, @delaySeconds, SYSUTCDATETIME()), ErrorMessage = @message,
            UsageJson = @usage, LeaseToken = NULL, LeaseUntil = NULL, UpdatedAt = SYSUTCDATETIME()
      WHERE ${HELD}`,
    { ...held(job), delaySeconds: Math.round(delaySeconds), message: message.slice(0, 4000), usage: usageJson },
  );
  return rows === 1;
}

// ---- the staff marking queue (slice A5b) ------------------------------------

export interface AwaitingAnswer {
  attemptId: string;
  questionId: string;
  learnerId: string;
  learnerName: string;
  submittedAt: Date | null;
  // When it joined the queue: submitted, or asked for review after an
  // instructor's mark.
  waitingSince: Date | null;
  courseTitle: string | null;
  lessonTitle: string | null;
  questionNumber: number;
  promptMd: string;
  rubricMd: string;
  maxScore: number;
  answer: string;
  aiGradeId: string | null;
  aiScore: number | null;
  aiMaxScore: number | null;
  aiFeedbackMd: string | null;
  instructorScore: number | null;
  review: { note: string | null; requestedAt: Date } | null;
}

export interface AwaitingQueue {
  total: number;
  answers: AwaitingAnswer[];
}

interface AwaitingRow {
  AttemptId: string;
  QuestionId: string;
  LearnerId: string;
  DisplayName: string;
  SubmittedAt: Date | null;
  ResponseJson: string;
  OrderIndex: number;
  PayloadJson: string;
  CourseTitle: string | null;
  LessonTitle: string | null;
  AiGradeId: string | null;
  AiScore: number | null;
  AiMaxScore: number | null;
  AiFeedbackMd: string | null;
  InstructorScore: number | null;
  ReviewNote: string | null;
  ReviewRequestedAt: Date | null;
  WaitingSince: Date | null;
  Waiting: number;
}

function answerText(json: string): string {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "string" ? value : "";
  } catch {
    return "";
  }
}

// The tenant's written answers that need an instructor, longest waiting first:
// no instructor's mark yet (the AI's provisional one or none at all), or a
// review the learner asked for that no instructor's mark has answered. An
// empty answer is left out: nothing was written, and before the player had a
// text box (A5b) every written answer was sent empty. `total` counts them all,
// beyond `limit`.
export async function listAnswersAwaitingInstructor(tenantId: string, limit = 50): Promise<AwaitingQueue> {
  const rows = await query<AwaitingRow>(
    `SELECT TOP (@limit) CONVERT(varchar(36), r.AttemptId) AS AttemptId, CONVERT(varchar(36), r.QuestionId) AS QuestionId,
            CONVERT(varchar(36), l.LearnerId) AS LearnerId, l.DisplayName, a.SubmittedAt, r.ResponseJson,
            qq.OrderIndex, qq.PayloadJson, c.Title AS CourseTitle, ls.Title AS LessonTitle,
            CONVERT(varchar(36), ai.GradeId) AS AiGradeId, ai.Score AS AiScore, ai.MaxScore AS AiMaxScore,
            ai.FeedbackMd AS AiFeedbackMd, ins.Score AS InstructorScore,
            rr.Note AS ReviewNote, rr.RequestedAt AS ReviewRequestedAt,
            CASE WHEN ins.GradeId IS NULL THEN a.SubmittedAt ELSE rr.RequestedAt END AS WaitingSince,
            COUNT(*) OVER () AS Waiting
       FROM lms.AnswerResponse r
       JOIN lms.QuizAttempt a ON a.AttemptId = r.AttemptId
       JOIN lms.Learner l ON l.LearnerId = a.LearnerId
       JOIN lms.QuizQuestion qq ON qq.QuestionId = r.QuestionId
       LEFT JOIN lms.Quiz q ON q.QuizId = a.QuizId
       LEFT JOIN lms.Block b ON b.BlockId = q.BlockId
       LEFT JOIN lms.Lesson ls ON ls.LessonId = b.LessonId
       LEFT JOIN lms.Course c ON c.CourseId = ls.CourseId
       OUTER APPLY (SELECT TOP (1) g.GradeId, g.Score, g.MaxScore, g.FeedbackMd
                      FROM lms.AnswerGrade g
                     WHERE g.TenantId = @tenantId AND g.AttemptId = r.AttemptId AND g.QuestionId = r.QuestionId
                       AND g.Source = 'ai'
                     ORDER BY g.Seq DESC) ai
       OUTER APPLY (SELECT TOP (1) i.GradeId, i.Score
                      FROM lms.AnswerGrade i
                     WHERE i.TenantId = @tenantId AND i.AttemptId = r.AttemptId AND i.QuestionId = r.QuestionId
                       AND i.Source = 'instructor'
                     ORDER BY i.Seq DESC) ins
       OUTER APPLY (SELECT TOP (1) x.Note, x.RequestedAt
                      FROM lms.AnswerReviewRequest x
                     WHERE x.TenantId = @tenantId AND x.AttemptId = r.AttemptId AND x.QuestionId = r.QuestionId
                       AND x.ResolvedByGradeId IS NULL) rr
      WHERE l.TenantId = @tenantId AND r.MachineScore IS NULL AND r.ResponseJson NOT IN (N'""', N'null')
        AND (ins.GradeId IS NULL OR rr.RequestedAt IS NOT NULL)
      ORDER BY WaitingSince, a.SubmittedAt, qq.OrderIndex`,
    { tenantId, limit: Math.max(1, Math.min(200, Math.trunc(limit))) },
  );
  const answers: AwaitingAnswer[] = [];
  for (const row of rows) {
    const question = parseQuestion(row.PayloadJson);
    if (question?.kind !== "short") continue;
    answers.push({
      attemptId: lower(row.AttemptId),
      questionId: lower(row.QuestionId),
      learnerId: lower(row.LearnerId),
      learnerName: row.DisplayName,
      submittedAt: row.SubmittedAt,
      waitingSince: row.WaitingSince,
      courseTitle: row.CourseTitle,
      lessonTitle: row.LessonTitle,
      questionNumber: row.OrderIndex + 1,
      promptMd: question.promptMd,
      rubricMd: question.rubricMd,
      maxScore: question.maxScore,
      answer: answerText(row.ResponseJson),
      aiGradeId: row.AiGradeId ? lower(row.AiGradeId) : null,
      aiScore: row.AiScore,
      aiMaxScore: row.AiMaxScore,
      aiFeedbackMd: row.AiFeedbackMd,
      instructorScore: row.InstructorScore,
      review: row.ReviewRequestedAt ? { note: row.ReviewNote, requestedAt: row.ReviewRequestedAt } : null,
    });
  }
  return { total: rows[0]?.Waiting ?? 0, answers };
}

export async function countAnswersAwaitingInstructor(tenantId: string): Promise<number> {
  return (await listAnswersAwaitingInstructor(tenantId, 1)).total;
}
