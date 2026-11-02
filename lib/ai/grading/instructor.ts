import { randomUUID } from "node:crypto";
import { appendInstructorGrade, readAttempt, type AttemptRecord, type InstructorVerb } from "@/lib/db/answer-grades";
import { recordExamMark } from "@/lib/records/writers";
import { scoreAttempt, type GradeRecord } from "./score";
import { MARK_FEEDBACK_MAX_CHARS, MARK_REASON_MAX_CHARS } from "./written-answer";

// An instructor's mark on a written answer (slice A5a; the staff marking queue
// that calls it is A5b). Either a mark of their own, which overrides whatever
// stood and must say why, or a confirmation of the AI's mark, which copies it.
// Either way it is a new lms.AnswerGrade row, it wins over the AI's, it moves
// the attempt's pass/fail score, and it writes its AuditEvent in the same
// transaction.

export const REASON_MAX_CHARS = MARK_REASON_MAX_CHARS;
export const FEEDBACK_MAX_CHARS = MARK_FEEDBACK_MAX_CHARS;
const APPEND_TRIES = 3;

export type InstructorMark =
  | { action: "override"; attemptId: string; questionId: string; score: number; reason: string; feedbackMd?: string | null }
  | { action: "confirm"; attemptId: string; questionId: string; gradeId: string };

export interface AttemptSummary {
  attemptId: string;
  score: number;
  provisionalScore: number;
  passingScore: number;
  passed: boolean;
}

export type InstructorMarkResult =
  | { ok: true; gradeId: string; attempt: AttemptSummary }
  | { ok: false; reason: "not_found" | "no_reason" | "score_out_of_range" | "busy" };

export async function recordInstructorMark(tenantId: string, by: string, mark: InstructorMark): Promise<InstructorMarkResult> {
  const attemptId = mark.attemptId.toLowerCase();
  const questionId = mark.questionId.toLowerCase();
  const reason = mark.action === "override" ? mark.reason.trim() : null;
  if (mark.action === "override" && !reason) return { ok: false, reason: "no_reason" };

  const gradeId = randomUUID();
  for (let tries = 0; tries < APPEND_TRIES; tries++) {
    const attempt = await readAttempt(tenantId, attemptId);
    const question = attempt?.answers.find((a) => a.questionId === questionId)?.question;
    if (!attempt || !question || question.kind !== "short") return { ok: false, reason: "not_found" };
    const maxScore = question.maxScore;

    let row: Pick<GradeRecord, "score" | "feedbackMd" | "confirmsGradeId">;
    if (mark.action === "confirm") {
      const confirmed = attempt.grades.find((g) => g.gradeId === mark.gradeId.toLowerCase() && g.questionId === questionId && g.source === "ai");
      if (!confirmed) return { ok: false, reason: "not_found" };
      row = { score: confirmed.score, feedbackMd: confirmed.feedbackMd, confirmsGradeId: confirmed.gradeId };
    } else {
      if (!Number.isInteger(mark.score) || mark.score < 0 || mark.score > maxScore) return { ok: false, reason: "score_out_of_range" };
      row = { score: mark.score, feedbackMd: mark.feedbackMd?.trim() || null, confirmsGradeId: null };
    }

    const grades: GradeRecord[] = [...attempt.grades, {
      gradeId, questionId, seq: attempt.grades.length + 1, source: "instructor", score: row.score, maxScore,
      feedbackMd: row.feedbackMd, model: null, promptVersion: null, gradedBy: by, gradedAt: new Date(),
      reason, confirmsGradeId: row.confirmsGradeId,
    }];
    const scored = scoreAttempt(attempt.answers, grades);
    const verb: InstructorVerb = mark.action === "confirm" ? "quiz.grade.confirm" : "quiz.grade.override";
    const outcome = await appendInstructorGrade(
      tenantId,
      { attemptId, seen: attempt.grades.length, attemptScore: scored.score },
      { gradeId, questionId, score: row.score, maxScore, feedbackMd: row.feedbackMd, gradedBy: by, reason, confirmsGradeId: row.confirmsGradeId },
      { verb, metaJson: auditMeta(attempt, questionId, gradeId, row, maxScore, scored.score) },
    );
    if (outcome === "appended") {
      await recordExamMark(tenantId, {
        attemptId, gradeId, by, passingScore: attempt.passingScore, answers: attempt.answers,
        before: scoreAttempt(attempt.answers, attempt.grades), after: scored,
      });
      return {
        ok: true,
        gradeId,
        attempt: {
          attemptId,
          score: scored.score,
          provisionalScore: scored.provisionalScore,
          passingScore: attempt.passingScore,
          passed: scored.score >= attempt.passingScore,
        },
      };
    }
    if (outcome === "not_found") return { ok: false, reason: "not_found" };
  }
  return { ok: false, reason: "busy" };
}

// Ids and numbers only: the reason and feedback are on the grade row it names.
function auditMeta(
  attempt: AttemptRecord,
  questionId: string,
  gradeId: string,
  row: Pick<GradeRecord, "score" | "confirmsGradeId">,
  maxScore: number,
  attemptScore: number,
): string {
  return JSON.stringify({
    questionId,
    gradeId,
    score: row.score,
    maxScore,
    ...(row.confirmsGradeId ? { confirms: row.confirmsGradeId } : {}),
    attemptScore,
    previousAttemptScore: attempt.storedScore,
  });
}
