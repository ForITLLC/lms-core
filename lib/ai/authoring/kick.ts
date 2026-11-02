import type { IngestionRecord } from "@/lib/db/ingestions";
import { recordError } from "@/lib/logging";
import { processNextIngestion, STAGE_BUDGET_MS } from "./job";

const SERVICE = "lms-ai-authoring";

// Until the two-minute schedule exists (plan row A2), kicks are what move jobs
// along: an enqueue, an enqueue refused at a cap, and a status read of a job
// that is due each run one pass of the cron worker's processor after the
// answer has gone. A pass claims the next due job of any tenant, so a job left
// paused at the stage budget or waiting to retry runs again while an author
// waits on it, and a tenant at its cap can't be stuck behind jobs nobody runs.
export async function kickWorker(): Promise<void> {
  try {
    await processNextIngestion({ budgetMs: STAGE_BUDGET_MS });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(SERVICE, `kick: ${message}`, "ERROR", error instanceof Error ? error.stack : undefined).catch(() => undefined);
  }
}

// Whether a pass would claim this job now: queued and due, or running under a
// lease that ran out because its worker died.
export function isDue(job: Pick<IngestionRecord, "status" | "notBefore" | "leaseUntil">, now = Date.now()): boolean {
  if (job.status === "queued") return job.notBefore.getTime() <= now;
  return job.status === "running" && job.leaseUntil !== null && job.leaseUntil.getTime() < now;
}
