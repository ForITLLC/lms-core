// Written answers' marks as people see them (slice A5b), shared by the
// learner routes, the course player and the staff marking queue. Client-safe:
// no server imports.

// Longer answers wait for an instructor rather than being cut short or paid
// for; the player's text box stops at the same length.
export const ANSWER_MAX_CHARS = 4000;
export const REVIEW_NOTE_MAX_CHARS = 500;
// What an instructor's mark may carry (POST /api/author/grades).
export const MARK_REASON_MAX_CHARS = 1000;
export const MARK_FEEDBACK_MAX_CHARS = 4000;

export const AI_MARKING_NOTICE =
  "Written answers are marked first by an AI model, and your instructor checks every mark.";

export type WrittenAnswerStatus = "awaiting_instructor" | "ai_provisional" | "instructor_confirmed" | "instructor_marked";

// "none": not asked; "open": asked and no instructor has marked it since;
// "answered": an instructor marked it after the learner asked.
export type ReviewState = "none" | "open" | "answered";

export interface WrittenAnswerMark {
  questionId: string;
  orderIndex: number;
  status: WrittenAnswerStatus;
  score: number | null;
  maxScore: number | null;
  feedbackMd: string | null;
  review: ReviewState;
  canAskForReview: boolean;
}

// GET /api/learner/quiz/attempts/[id]. `score` decides pass or fail;
// `provisionalScore` also counts the AI's marks and is never used for it.
export interface AttemptMarks {
  attemptId: string;
  score: number;
  provisionalScore: number;
  passingScore: number;
  passed: boolean;
  waiting: boolean;
  written: WrittenAnswerMark[];
}

export function statusText(mark: Pick<WrittenAnswerMark, "status" | "score" | "maxScore">): string {
  const points = `${mark.score ?? 0}/${mark.maxScore ?? 0}`;
  switch (mark.status) {
    case "awaiting_instructor":
      return "Waiting for your instructor";
    case "ai_provisional":
      return `Provisional mark ${points} (marked by AI; your instructor will confirm it)`;
    case "instructor_confirmed":
      return `Mark ${points}, confirmed by your instructor`;
    case "instructor_marked":
      return `Mark ${points} from your instructor`;
  }
}

export function reviewText(review: ReviewState): string | null {
  if (review === "open") return "You asked your instructor to look at this again.";
  if (review === "answered") return "Your instructor looked at this again.";
  return null;
}

// Pass or fail comes from the deciding score alone. `waiting` is true while
// any written answer has no instructor's mark, AI-marked ones included.
export function verdictText(result: { score: number; provisionalScore?: number; passingScore: number; waiting: boolean }): string {
  const verdict = result.score >= result.passingScore ? "Passed." : `The pass mark is ${result.passingScore}%.`;
  const line = `Knowledge check score: ${result.score}%. ${verdict}`;
  return result.waiting
    ? `${line} Some written answers haven't been marked by your instructor yet, so this result may change once they are.`
    : line;
}
