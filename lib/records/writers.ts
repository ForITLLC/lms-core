import type { GradeResult, QuizResponse, RecordedAttempt } from "@/lib/db/quizzes";
import { appendTrainingRecord, readAttemptContext, readCompletionContext, type TrainingRecordInput } from "@/lib/db/training-records";
import { recordError } from "@/lib/logging";
import { trainingRecordsEnabled } from "./switch";

// The automatic training-record writers (docs/plans/2026-10-29-training-records-design.md
// §3.2, slice R1a). Each is called after the event it records is saved and
// never fails the caller: a write that fails is logged and the learner's or
// instructor's action stands. They write only for tenants listed in
// TRAINING_RECORDS_TENANTS (./switch.ts), and nothing they read or write goes
// to an AI model.
//
// Only an attempt at an exam is recorded: a quiz its author published with
// "This quiz is an exam" ticked (lms.Quiz.IsExam). A practice quiz's attempts
// write nothing. An exam attempt is recorded once its result is decided. While a written
// answer the staff marking queue lists still has no mark that may decide
// (lib/ai/grading/policy.ts: only an instructor's), the attempt's pass/fail
// can still move, so submitting it writes an exam_attempt_pending record,
// never a fail. The instructor mark that decides the last such answer writes
// the exam_pass or exam_fail record; a later mark that turns a pass into a
// fail or back writes a grade_change. A blank written answer is never listed
// for marking (lib/db/answer-grades.ts, the staff queue), so it holds nothing
// open.

export const SERVICE = "lms-training-records";

// Mirrors the staff marking queue's `r.ResponseJson NOT IN (N'""', N'null')`.
export const UNLISTED_RESPONSES: readonly string[] = ['""', "null"];

export interface ExamVerdict {
  score: number;
  passingScore: number;
  awaitingMarks: number;
}

interface ScoredAnswers {
  score: number;
  answers: readonly { questionId: string; decidesPass: boolean }[];
}

interface AnswerText {
  questionId: string;
  responseJson: string;
}

export function examVerdict(answers: readonly AnswerText[], scored: ScoredAnswers, passingScore: number): ExamVerdict {
  const listed = new Set(answers.filter((a) => !UNLISTED_RESPONSES.includes(a.responseJson)).map((a) => a.questionId.toLowerCase()));
  const awaitingMarks = scored.answers.filter((a) => !a.decidesPass && listed.has(a.questionId.toLowerCase())).length;
  return { score: scored.score, passingScore, awaitingMarks };
}

type ExamOutcome = "pending" | "pass" | "fail";

export function examOutcome(verdict: ExamVerdict): ExamOutcome {
  if (verdict.awaitingMarks > 0) return "pending";
  return verdict.score >= verdict.passingScore ? "pass" : "fail";
}

const failureDetail = (v: ExamVerdict) => `scored ${v.score}, needed ${v.passingScore}`;

async function guarded(tenantId: string, what: string, write: () => Promise<boolean>): Promise<boolean> {
  try {
    if (!(await trainingRecordsEnabled(tenantId))) return false;
    return await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(SERVICE, `${what}: ${message}`, "ERROR", error instanceof Error ? error.stack : undefined).catch(() => undefined);
    return false;
  }
}

// A completed enrollment: once per completion, so the caller calls it only
// when its update stamped CompletedAt. A recertification cycle carries its
// CycleNo in the payload.
export async function recordCourseCompletion(tenantId: string, learnerId: string, courseId: string): Promise<boolean> {
  return guarded(tenantId, `course_completion tenant=${tenantId} learner=${learnerId} course=${courseId}`, async () => {
    const ctx = await readCompletionContext(tenantId, learnerId, courseId);
    if (!ctx) return false;
    const record = await appendTrainingRecord(tenantId, {
      learnerId,
      kind: "course_completion",
      occurredAt: ctx.completedAt,
      result: "completed",
      source: "auto",
      recordedBy: ctx.learnerEmail,
      courseId: ctx.courseId,
      courseVersionId: ctx.versionId,
      courseTitle: ctx.courseTitle,
      payloadJson: JSON.stringify({ cycleNo: ctx.cycleNo }),
    });
    return record !== null;
  });
}

function examRecord(outcome: ExamOutcome, verdict: ExamVerdict): Pick<TrainingRecordInput, "kind" | "result" | "score" | "passingScore" | "failureDetail"> {
  if (outcome === "pending") {
    return { kind: "exam_attempt_pending", result: "pending", score: null, passingScore: verdict.passingScore, failureDetail: null };
  }
  if (outcome === "pass") {
    return { kind: "exam_pass", result: "pass", score: verdict.score, passingScore: verdict.passingScore, failureDetail: null };
  }
  return { kind: "exam_fail", result: "fail", score: verdict.score, passingScore: verdict.passingScore, failureDetail: failureDetail(verdict) };
}

// A submitted attempt, as the submit route recorded it: the attempt's score
// and its answers. Written answers have no mark yet, so none of them decides.
export async function recordExamAttempt(
  tenantId: string,
  attempt: RecordedAttempt,
  grade: GradeResult,
  responses: readonly QuizResponse[],
): Promise<boolean> {
  return guarded(tenantId, `exam_attempt tenant=${tenantId} attempt=${attempt.attemptId}`, async () => {
    const verdict = examVerdict(
      grade.perQuestion.map((p) => ({ questionId: p.questionId, responseJson: JSON.stringify(responses[p.orderIndex] ?? null) })),
      { score: attempt.score, answers: grade.perQuestion.map((p) => ({ questionId: p.questionId, decidesPass: p.autoGradable })) },
      attempt.passingScore,
    );
    const ctx = await readAttemptContext(tenantId, attempt.attemptId);
    if (!ctx?.isExam) return false;
    const outcome = examOutcome(verdict);
    const record = await appendTrainingRecord(tenantId, {
      ...examRecord(outcome, verdict),
      learnerId: ctx.learnerId,
      occurredAt: ctx.submittedAt,
      source: "auto",
      recordedBy: ctx.learnerEmail,
      courseId: ctx.courseId,
      courseVersionId: ctx.versionId,
      courseTitle: ctx.courseTitle,
      quizId: ctx.quizId,
      attemptId: attempt.attemptId,
      payloadJson: outcome === "pending" ? JSON.stringify({ awaitingMarks: verdict.awaitingMarks }) : null,
    });
    return record !== null;
  });
}

export interface ExamMark {
  attemptId: string;
  gradeId: string;
  by: string;
  passingScore: number;
  answers: readonly AnswerText[];
  before: ScoredAnswers;
  after: ScoredAnswers;
}

// An instructor's mark, once it is saved: records the attempt's result when
// the mark decides it, or a grade_change when it turns a decided pass into a
// fail or a fail into a pass. Any other mark records nothing.
export async function recordExamMark(tenantId: string, mark: ExamMark): Promise<boolean> {
  const was = examVerdict(mark.answers, mark.before, mark.passingScore);
  const now = examVerdict(mark.answers, mark.after, mark.passingScore);
  const from = examOutcome(was);
  const to = examOutcome(now);
  if (to === "pending" || (from !== "pending" && from === to)) return false;

  return guarded(tenantId, `exam_mark tenant=${tenantId} attempt=${mark.attemptId} grade=${mark.gradeId}`, async () => {
    const ctx = await readAttemptContext(tenantId, mark.attemptId);
    if (!ctx?.isExam) return false;
    const where = {
      learnerId: ctx.learnerId,
      source: "auto" as const,
      recordedBy: mark.by,
      courseId: ctx.courseId,
      courseVersionId: ctx.versionId,
      courseTitle: ctx.courseTitle,
      quizId: ctx.quizId,
      attemptId: mark.attemptId,
    };
    const record = from === "pending"
      ? await appendTrainingRecord(tenantId, {
          ...examRecord(to, now),
          ...where,
          occurredAt: ctx.submittedAt,
          payloadJson: JSON.stringify({ decidedByGradeId: mark.gradeId }),
        })
      : await appendTrainingRecord(tenantId, {
          kind: "grade_change",
          result: to,
          score: now.score,
          passingScore: now.passingScore,
          failureDetail: to === "fail" ? failureDetail(now) : null,
          ...where,
          occurredAt: new Date(),
          payloadJson: JSON.stringify({ gradeId: mark.gradeId, previousResult: from, previousScore: was.score }),
        });
    return record !== null;
  });
}
