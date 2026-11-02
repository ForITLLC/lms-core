// What app/api/learner/complete/route.ts refuses with a 409, shared with the
// author preview (components/author/preview-effects.ts) so a preview refuses
// what a learner would be refused. Browser-safe: never import lib/db here.

export interface CompletionRefusal {
  error: string;
  code: "quiz_submission_required" | "package_incomplete";
}

// Every quiz the gate counts needs a submitted attempt, passed or not.
export function unsubmittedQuizRefusal(quizzes: ReadonlyArray<{ submitted: boolean }>): CompletionRefusal | null {
  if (!quizzes.some((quiz) => !quiz.submitted)) return null;
  return { error: "Submit every quiz before completing this course.", code: "quiz_submission_required" };
}

// A package block is done only by its activity, never by reaching the last slide.
export function pendingPackageRefusal(pendingPackageBlocks: number): CompletionRefusal | null {
  if (pendingPackageBlocks <= 0) return null;
  return { error: "Finish every activity before completing this course.", code: "package_incomplete" };
}
