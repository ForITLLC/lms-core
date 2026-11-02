import { recordError } from "@/lib/logging";
import { processGradingJobs, SERVICE } from "./job";

// Until a schedule posts to /api/cron/ai-grading (plan row A2's trigger card),
// a recorded attempt with written answers to mark kicks the worker once its
// answer has gone. A pass takes the next due jobs of any tenant, a few at a
// time, so jobs a kick left behind move with the next one.
export const KICK_MAX_JOBS = 10;
export const KICK_BUDGET_MS = 120_000;

export async function kickGrading(): Promise<void> {
  try {
    await processGradingJobs({ budgetMs: KICK_BUDGET_MS, maxJobs: KICK_MAX_JOBS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(SERVICE, `kick: ${message}`, "ERROR", error instanceof Error ? error.stack : undefined).catch(() => undefined);
  }
}
