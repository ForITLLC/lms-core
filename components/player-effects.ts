import type { AttemptMarks } from "@/lib/ai/grading/written-answer";

// What the course player does beyond showing slides: grade a quiz, record a
// slide as seen, record completion, offer feedback, and follow the marks on
// written answers. CoursePlayer takes
// these as one object so a caller other than the learner page (the author
// preview, components/author/preview-effects.ts) can swap every write out at
// once. Client-safe: never import the server-only lib/db modules here.

// A single question's answer (mcq/confidence choice id, tf boolean, multi ids).
// QuizResponse adds null for "not yet answered", the positional shape the
// grader reads.
export type QuizAnswer = string | boolean | string[];
export type QuizResponse = QuizAnswer | null;

export interface QuizResult {
  // The learner's stored attempt; absent in the author preview, which stores none.
  attemptId?: string;
  score: number;
  passed: boolean;
  passingScore: number;
  correctCount: number;
  autoGradableCount: number;
  perQuestion: Array<{ orderIndex: number; correct: boolean | null }>;
}

export interface QuizGate {
  required: boolean;
  passed: boolean;
  totalQuizzes: number;
  passedQuizzes: number;
  quizzes: Array<{ passingScore: number; bestScore: number | null; passed: boolean }>;
}

export interface CompletionOutcome {
  completed: boolean;
  serialNo: string | null;
  quizGate: QuizGate | null;
}

export interface PlayerEffects {
  submitQuiz: (quizId: string, responses: QuizResponse[]) => Promise<QuizResult>;
  recordSeen: (blockId: string) => Promise<void>;
  complete: () => Promise<CompletionOutcome>;
  // Slide and course feedback forms, which post to the learner feedback API.
  feedback: boolean;
  // The marks on the written answers of a stored attempt, and a request for an
  // instructor to look at one again (slice A5b). Absent, the player shows no
  // marks and offers no review.
  readAttempt?: (attemptId: string) => Promise<AttemptMarks>;
  requestReview?: (review: { attemptId: string; questionId: string; note: string | null }) => Promise<void>;
}

const JSON_HEADERS = { "Content-Type": "application/json" };

function okJson<T>(r: Response): Promise<T> {
  return r.ok ? (r.json() as Promise<T>) : Promise.reject(new Error(String(r.status)));
}

// A refusal the route explains (409: already asked, not marked yet) carries
// its own words; anything else gets a generic retry line.
async function reviewRefusal(r: Response): Promise<never> {
  const data = (await r.json().catch(() => ({}))) as { error?: unknown };
  const said = r.status === 409 && typeof data.error === "string" ? data.error : null;
  throw new Error(said ?? "We couldn't send your request. Try again in a moment.");
}

// The learner's own player: grading and progress persist server-side.
export function learnerEffects(courseId: string): PlayerEffects {
  return {
    submitQuiz: (quizId, responses) =>
      fetch("/api/learner/quiz/submit", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ courseId, quizId, responses }),
      }).then((r) => okJson<QuizResult>(r)),
    recordSeen: (blockId) =>
      fetch("/api/learner/progress", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ courseId, blockId }),
        keepalive: true,
      }).then(() => undefined),
    complete: () =>
      fetch("/api/learner/complete", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ courseId }),
      })
        .then((r) =>
          okJson<{
            progress?: { completed?: boolean };
            certificate?: { serialNo: string } | null;
            quizGate?: QuizGate | null;
          }>(r),
        )
        .then((data) => ({
          completed: Boolean(data.progress?.completed),
          serialNo: data.certificate?.serialNo ?? null,
          quizGate: data.quizGate ?? null,
        })),
    feedback: true,
    readAttempt: (attemptId) =>
      fetch(`/api/learner/quiz/attempts/${encodeURIComponent(attemptId)}`, { cache: "no-store" }).then((r) => okJson<AttemptMarks>(r)),
    requestReview: (review) =>
      fetch("/api/learner/grades/review", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify(review),
      }).then((r) => (r.ok ? undefined : reviewRefusal(r))),
  };
}
