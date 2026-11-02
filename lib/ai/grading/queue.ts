import type { GradableQuestion, QuizResponse } from "@/lib/db/quizzes";
import { enqueueGradingJob } from "@/lib/db/answer-grades";
import { recordError } from "@/lib/logging";
import { markableAnswer } from "./grader";
import { aiMarkingEnabled } from "./policy";

const SERVICE = "lms-ai-grading";

// Called once an attempt is recorded: one AI marking job per written answer,
// only where AI marking is on for the tenant (policy.ts, Q4). Off, nothing is
// queued and the answers wait for an instructor, as they always have. The
// switches aren't read for an attempt with no written answer to mark. Never
// throws: the attempt is already saved, and a queue that failed leaves its
// answers with the instructor too. Answers how many jobs it queued.
export async function queueAnswerMarking(
  tenantId: string,
  attemptId: string,
  questions: readonly GradableQuestion[],
  responses: readonly QuizResponse[],
): Promise<number> {
  const written = questions.filter((q) => q.question.kind === "short" && markableAnswer(responses[q.orderIndex] ?? null) !== null);
  if (written.length === 0) return 0;
  let queued = 0;
  try {
    if (!(await aiMarkingEnabled(tenantId))) return 0;
    for (const q of written) {
      if (await enqueueGradingJob(tenantId, attemptId, q.questionId)) queued += 1;
    }
    return queued;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(SERVICE, `enqueue tenant=${tenantId} attempt=${attemptId}: ${message}`, "ERROR").catch(() => undefined);
    return queued;
  }
}
