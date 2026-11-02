import { randomUUID } from "node:crypto";
import {
  appendAiGrade,
  claimNextGradingJob,
  completeGradingJob,
  endGradingJob,
  readAttempt,
  requeueGradingJob,
  type AttemptRecord,
  type ClaimedGradingJob,
} from "@/lib/db/answer-grades";
import { recordError, recordServiceRun } from "@/lib/logging";
import { transientAiError } from "@/lib/ai/claude";
import { addUsage, ModelOutputError, readUsage, tokenTotals } from "@/lib/ai/authoring/usage";
import { markableAnswer, markShortAnswer } from "./grader";
import { aiMarkingEnabled } from "./policy";
import { scoreAttempt, standingGrade } from "./score";

// The AI marking worker (docs/plans/2026-10-29-ai-authoring.md, slice A5a), on
// the A2 queue pattern: claim a job under a lease, then every write names the
// job's tenant and token. One job is one written answer. The switches are read
// again for the claimed job's tenant before anything is sent, so turning AI
// marking off stops jobs already queued. Logs carry ids and token counts only,
// never an answer, a rubric or a mark.

export const SERVICE = "lms-ai-grading";
export const GRADING_BUDGET_MS = 200_000;
export const GRADING_REQUEUES = 3;
const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 15 * 60;
const APPEND_TRIES = 3;

export const MARKING_OFF = "AI marking is off for this organisation; the answer waits for an instructor.";

export type GradingOutcome =
  | { outcome: "idle" }
  | { outcome: "marked"; jobId: string; gradeId: string }
  // The answer already had a mark (an instructor's, or this job's own from a
  // run that stopped before it could say so); nothing was sent.
  | { outcome: "skipped"; jobId: string }
  | { outcome: "cancelled"; jobId: string }
  | { outcome: "requeued"; jobId: string; delaySeconds: number }
  | { outcome: "failed"; jobId: string; error: string }
  | { outcome: "lease_lost"; jobId: string };

export interface GradingRunOptions {
  now?: () => number;
}

class PermanentGradingError extends Error {}
class LeaseLostError extends Error {}
class MarksChangedError extends Error {}

export async function processNextGrading(options: GradingRunOptions = {}): Promise<GradingOutcome> {
  const job = await claimNextGradingJob();
  return job ? runGradingJob(job, options) : { outcome: "idle" };
}

// Jobs one after another until the queue is empty, the budget is spent or
// maxJobs have run.
export async function processGradingJobs(
  options: GradingRunOptions & { budgetMs?: number; maxJobs: number },
): Promise<GradingOutcome[]> {
  const now = options.now ?? Date.now;
  const started = now();
  const budget = options.budgetMs ?? GRADING_BUDGET_MS;
  const outcomes: GradingOutcome[] = [];
  while (outcomes.length < options.maxJobs && now() - started < budget) {
    const outcome = await processNextGrading(options);
    if (outcome.outcome === "idle") break;
    outcomes.push(outcome);
  }
  return outcomes;
}

export async function runGradingJob(job: ClaimedGradingJob, options: GradingRunOptions = {}): Promise<GradingOutcome> {
  const now = options.now ?? Date.now;
  const started = now();
  const { jobId, tenantId, attemptId, questionId } = job;
  const run = `tenant=${tenantId} attempt=${attemptId} question=${questionId} job=${jobId} try=${job.attempts}`;
  let usage = readUsage(job.usageJson);
  const usageJson = () => JSON.stringify(usage);
  const tokens = () => {
    const { tokensIn, tokensOut } = tokenTotals(usage);
    return `tokens in=${tokensIn} out=${tokensOut}`;
  };

  try {
    if (!(await aiMarkingEnabled(tenantId))) {
      if (!(await endGradingJob(job, "cancelled", MARKING_OFF, usageJson()))) throw new LeaseLostError();
      await recordServiceRun(SERVICE, "SUCCESS", now() - started, 0, `${run} cancelled: AI marking is off`);
      return { outcome: "cancelled", jobId };
    }
    if (job.attempts > GRADING_REQUEUES + 1) {
      throw new PermanentGradingError(`Stopped after ${job.attempts - 1} tries; the last one never finished.`);
    }

    let attempt = await mustRead(tenantId, attemptId);
    const answer = attempt.answers.find((a) => a.questionId === questionId);
    const question = answer?.question;
    if (!answer || !question || question.kind !== "short") throw new PermanentGradingError("The answer isn't a written answer of this attempt.");
    const standing = standingGrade(attempt.grades, questionId);
    if (standing) {
      if (!(await completeGradingJob(job, standing.source === "ai" ? standing.gradeId : null, usageJson()))) throw new LeaseLostError();
      await recordServiceRun(SERVICE, "SUCCESS", now() - started, 0, `${run} skipped: already marked by ${standing.source}`);
      return { outcome: "skipped", jobId };
    }
    const text = markableAnswer(readResponse(answer.responseJson));
    if (text === null) throw new PermanentGradingError("The answer is empty or too long to mark with AI.");

    const mark = await markShortAnswer({ promptMd: question.promptMd, rubricMd: question.rubricMd, maxScore: question.maxScore, answer: text })
      .catch((err: unknown) => {
        if (err instanceof ModelOutputError) usage = addUsage(usage, err.usage);
        throw err;
      });
    usage = addUsage(usage, mark.usage);

    const gradeId = randomUUID();
    for (let tries = 0; tries < APPEND_TRIES; tries++) {
      const grades = [...attempt.grades, aiRow(gradeId, questionId, attempt.grades.length + 1, mark, question.maxScore)];
      const outcome = await appendAiGrade(
        job,
        { attemptId, seen: attempt.grades.length, attemptScore: scoreAttempt(attempt.answers, grades).score },
        { gradeId, questionId, score: mark.score, maxScore: question.maxScore, feedbackMd: mark.feedbackMd, model: mark.model, promptVersion: mark.promptVersion },
        usageJson(),
      );
      if (outcome === "appended") {
        await recordServiceRun(SERVICE, "SUCCESS", now() - started, 1, `${run} grade=${gradeId} ${tokens()}`);
        return { outcome: "marked", jobId, gradeId };
      }
      if (outcome === "lease_lost") throw new LeaseLostError();
      if (outcome === "not_found") throw new PermanentGradingError("The attempt is gone.");
      attempt = await mustRead(tenantId, attemptId);
    }
    throw new MarksChangedError("The attempt's marks kept changing while the AI mark was saved.");
  } catch (err) {
    return failure(err);
  }

  async function failure(err: unknown): Promise<GradingOutcome> {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LeaseLostError) return notOurs();
    const transient = err instanceof MarksChangedError ? { retryAfterMs: null } : transientAiError(err);
    if (transient && job.attempts <= GRADING_REQUEUES) {
      const delaySeconds = backoffSeconds(job.attempts, transient.retryAfterMs);
      if (!(await requeueGradingJob(job, delaySeconds, msg, usageJson()))) return notOurs();
      await recordError(SERVICE, `${run} requeued in ${delaySeconds}s: ${msg}`, "WARNING");
      return { outcome: "requeued", jobId, delaySeconds };
    }
    const error = transient ? `Gave up after ${job.attempts} tries: ${msg}` : msg;
    if (!(await endGradingJob(job, "failed", error, usageJson()))) return notOurs();
    await recordError(SERVICE, `${run}: ${error}`, "ERROR", err instanceof Error ? err.stack : undefined);
    await recordServiceRun(SERVICE, "FAILURE", now() - started, 0, `${run}: ${error.slice(0, 3500)} ${tokens()}`, 1);
    return { outcome: "failed", jobId, error };
  }

  async function notOurs(): Promise<GradingOutcome> {
    await recordError(SERVICE, `${run}: the job is no longer this worker's to change; it stopped`, "WARNING");
    return { outcome: "lease_lost", jobId };
  }
}

async function mustRead(tenantId: string, attemptId: string): Promise<AttemptRecord> {
  const attempt = await readAttempt(tenantId, attemptId);
  if (!attempt) throw new PermanentGradingError("The attempt is gone.");
  return attempt;
}

function readResponse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function aiRow(gradeId: string, questionId: string, seq: number, mark: { score: number; feedbackMd: string; model: string; promptVersion: string }, maxScore: number) {
  return {
    gradeId,
    questionId,
    seq,
    source: "ai" as const,
    score: mark.score,
    maxScore,
    feedbackMd: mark.feedbackMd,
    model: mark.model,
    promptVersion: mark.promptVersion,
    gradedBy: null,
    gradedAt: new Date(),
    reason: null,
    confirmsGradeId: null,
  };
}

export function backoffSeconds(attempt: number, retryAfterMs: number | null): number {
  const doubled = BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempt - 1);
  const hinted = retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 0;
  return Math.min(BACKOFF_MAX_SECONDS, Math.max(doubled, hinted));
}
