import type { CompletionOutcome, PlayerEffects, QuizResponse, QuizResult } from "@/components/player-effects";
import type { PreviewTarget } from "@/lib/builder/preview";
import { pendingPackageRefusal, unsubmittedQuizRefusal, type CompletionRefusal } from "@/lib/completion-gate";

// The player's effects in the author preview. Nothing here writes learner
// state: no progress beacon, no attempt, no completion or certificate, no
// feedback. A quiz is graded by POST /api/author/courses/[courseId]/draft/grade,
// which records nothing; completion follows the learner complete route's rules
// (lib/completion-gate.ts) over this visit's results, keeping each quiz's best
// score as the learner gate does.

export interface PreviewEffectsInput {
  courseId: string;
  target: PreviewTarget;
  // Preview quiz id to draft block key, from lib/builder/preview.ts.
  quizKeys: Record<string, string>;
  requiresQuizPass: boolean;
  packageBlocks: number;
  // Told when the grader refuses the preview as out of date or gone.
  onStale?: (message: string) => void;
  fetcher?: typeof fetch;
}

export const STALE_DRAFT = "The draft changed after this preview opened. Reload the preview to see the latest version.";
export const GONE_DRAFT = "This draft was published or discarded after the preview opened. Reload the preview.";
export const GONE_VERSION = "This published version can't be found any more. Reload the preview.";
export const MISSING_QUIZ = "This quiz isn't in this version of the course any more. Reload the preview.";

// complete() rejects where the learner route answers 409, so the player shows
// it the way it shows a learner's refused completion.
export class PreviewCompletionRefused extends Error {
  readonly refusal: CompletionRefusal;
  constructor(refusal: CompletionRefusal) {
    super(refusal.error);
    this.refusal = refusal;
  }
}

function goneMessage(target: PreviewTarget, code: unknown): string {
  if (code === "block_not_found") return MISSING_QUIZ;
  return target.draftId === null ? GONE_VERSION : GONE_DRAFT;
}

export function previewEffects({
  courseId,
  target,
  quizKeys,
  requiresQuizPass,
  packageBlocks,
  onStale,
  fetcher = (...args) => fetch(...args),
}: PreviewEffectsInput): PlayerEffects {
  const best = new Map<string, QuizResult>();
  const gradeUrl = `/api/author/courses/${encodeURIComponent(courseId)}/draft/grade`;

  const submitQuiz = async (quizId: string, responses: QuizResponse[]): Promise<QuizResult> => {
    const blockKey = quizKeys[quizId];
    if (!blockKey) throw new Error("unknown quiz");
    const res = await fetcher(gradeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...target, blockKey, responses }),
      cache: "no-store",
    });
    if (res.status === 409) onStale?.(STALE_DRAFT);
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { code?: unknown } | null;
      onStale?.(goneMessage(target, body?.code));
    }
    if (!res.ok) throw new Error(String(res.status));
    const result = (await res.json()) as QuizResult;
    const previous = best.get(quizId);
    if (!previous || result.score > previous.score) best.set(quizId, result);
    return result;
  };

  const complete = async (): Promise<CompletionOutcome> => {
    const results = Object.keys(quizKeys).map((quizId) => best.get(quizId));
    const refusal =
      unsubmittedQuizRefusal(results.map((result) => ({ submitted: result !== undefined }))) ??
      pendingPackageRefusal(packageBlocks);
    if (refusal) throw new PreviewCompletionRefused(refusal);
    const graded = results.filter((result): result is QuizResult => result !== undefined);
    const passedQuizzes = graded.filter((result) => result.passed).length;
    const passed = passedQuizzes === graded.length;
    return {
      completed: !requiresQuizPass || passed,
      serialNo: null,
      quizGate: requiresQuizPass
        ? {
            required: true,
            passed,
            totalQuizzes: graded.length,
            passedQuizzes,
            quizzes: graded.map((result) => ({ passingScore: result.passingScore, bestScore: result.score, passed: result.passed })),
          }
        : null,
    };
  };

  return { submitQuiz, recordSeen: async () => undefined, complete, feedback: false };
}
