import { GRADING_BUDGET_MS, processGradingJobs, SERVICE } from "@/lib/ai/grading/job";
import { recordError, recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The AI marking worker: due marking jobs of any tenant, one after another,
// until the queue is empty or this call's budget is spent. Bearer-protected by
// CRON_SECRET like the other /api/cron routes. The answer carries counts by
// outcome only, never an answer, a mark or an error's text.
const CRON_MAX_JOBS = 50;

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Forbidden", { status: 403 });
  }
  const started = Date.now();
  try {
    const outcomes = await processGradingJobs({ budgetMs: GRADING_BUDGET_MS, maxJobs: CRON_MAX_JOBS });
    const counts: Record<string, number> = {};
    for (const { outcome } of outcomes) counts[outcome] = (counts[outcome] ?? 0) + 1;
    return Response.json({ ok: true, processed: outcomes.length, outcomes: counts });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError(SERVICE, `worker: ${message}`, "ERROR", error instanceof Error ? error.stack : undefined).catch(() => undefined);
    await recordServiceRun(SERVICE, "FAILURE", Date.now() - started, 0, `worker: ${message}`, 1).catch(() => undefined);
    return Response.json({ ok: false, error: "The marking worker failed" }, { status: 500 });
  }
}
