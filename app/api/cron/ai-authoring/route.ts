import { processNextIngestion, STAGE_BUDGET_MS } from "@/lib/ai/authoring/job";
import { recordError, recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

// The AI authoring worker: claims the next due job of any tenant and runs it
// until it ends or this call's stage budget is spent, one job per call; a
// paused or requeued job is picked up by a later call. Bearer-protected by
// CRON_SECRET like the other /api/cron routes, and under /api/cron because
// middleware gates /api/admin with the session cookie. The answer carries ids
// and an outcome only, never the job's content or error text.
export async function POST(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Forbidden", { status: 403 });
  }
  const started = Date.now();
  try {
    const result = await processNextIngestion({ budgetMs: STAGE_BUDGET_MS });
    const ingestionId = "ingestionId" in result ? result.ingestionId : null;
    const courseId = "courseId" in result ? result.courseId : null;
    return Response.json({ ok: true, outcome: result.outcome, ingestionId, courseId });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordError("lms-ai-authoring", `worker: ${message}`, "ERROR", error instanceof Error ? error.stack : undefined).catch(() => undefined);
    await recordServiceRun("lms-ai-authoring", "FAILURE", Date.now() - started, 0, `worker: ${message}`, 1).catch(() => undefined);
    return Response.json({ ok: false, error: "The authoring worker failed" }, { status: 500 });
  }
}
