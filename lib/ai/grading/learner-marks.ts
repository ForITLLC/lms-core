import type { AttemptRecord } from "@/lib/db/answer-grades";
import type { ReviewRequestRecord } from "@/lib/db/answer-reviews";
import { scoreAttempt } from "./score";
import type { AttemptMarks, ReviewState, WrittenAnswerMark } from "./written-answer";

// What a learner is told about their own attempt's written answers (slice
// A5b): each one's status, mark and feedback, and whether they can still ask
// for a review. Never their answer text, the rubric, the model, who marked it
// or an override's reason. Pass or fail is the deciding score's (policy.ts, Q3).
export function learnerMarks(attempt: AttemptRecord, reviews: readonly ReviewRequestRecord[]): AttemptMarks {
  const scored = scoreAttempt(attempt.answers, attempt.grades);
  const written: WrittenAnswerMark[] = [];
  for (const answer of scored.answers) {
    if (answer.status === "auto") continue;
    const request = reviews.find((r) => r.questionId === answer.questionId);
    const review: ReviewState = !request ? "none" : request.resolvedByGradeId ? "answered" : "open";
    written.push({
      questionId: answer.questionId,
      orderIndex: answer.orderIndex,
      status: answer.status,
      score: answer.score,
      maxScore: answer.maxScore,
      feedbackMd: answer.feedbackMd,
      review,
      canAskForReview: review === "none" && answer.status !== "awaiting_instructor",
    });
  }
  return {
    attemptId: attempt.attemptId,
    score: scored.score,
    provisionalScore: scored.provisionalScore,
    passingScore: attempt.passingScore,
    passed: scored.score >= attempt.passingScore,
    waiting: written.some((w) => w.status === "awaiting_instructor" || w.status === "ai_provisional"),
    written,
  };
}
