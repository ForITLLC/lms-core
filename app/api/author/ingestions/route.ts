import { after } from "next/server";
import { z } from "zod";
import { noStoreJson, requireTenantStaff, staffRouteFailure } from "@/lib/auth/staff-gate";
import { ingestionInput, type IngestionInput } from "@/lib/ai/authoring/job";
import { kickWorker } from "@/lib/ai/authoring/kick";
import { AI_AUTHORING_OFF, aiAuthoringEnabled, INGESTION_LIMITS, limitMessage } from "@/lib/ai/authoring/limits";
import { AuthoringOptions, LESSON_COUNT_MAX, LESSON_COUNT_MIN } from "@/lib/ai/authoring/options";
import { SourceRefusedError } from "@/lib/ai/authoring/source";
import { enqueueIngestionWithinLimits } from "@/lib/db/ingestions";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-authoring";

// "Create with AI" (docs/plans/2026-10-29-ai-authoring.md, slice A4): an author
// or admin queues a job for their own tenant, which answers 202 with its id at
// once; the progress page polls GET /api/author/ingestions/[id]. The tenant
// comes from the session only. Off for a tenant not switched on
// (lib/ai/authoring/limits.ts), and capped per tenant there too. A refusal at
// a cap still kicks the worker, so the jobs holding the cap keep moving.

const Body = z
  .object({
    source: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("youtube"), url: z.string() }).strict(),
      z.object({ kind: z.literal("url"), url: z.string() }).strict(),
      z.object({ kind: z.literal("text"), title: z.string(), text: z.string() }).strict(),
    ]),
    options: AuthoringOptions.default({}),
  })
  .strict();

const BAD_BODY = `Choose a source (a YouTube link, a web page link, or pasted text with a title), a lesson count from ${LESSON_COUNT_MIN} to ${LESSON_COUNT_MAX}, and quizzes on or off.`;

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantStaff();
    if (!gate.ok) return gate.response;
    if (!(await aiAuthoringEnabled(gate.tenantId))) return noStoreJson({ error: AI_AUTHORING_OFF }, 403);

    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return noStoreJson({ error: BAD_BODY }, 400);
    let input: IngestionInput;
    try {
      input = ingestionInput(gate.email, body.data.source, body.data.options);
    } catch (error) {
      if (error instanceof SourceRefusedError) return noStoreJson({ error: error.message }, 400);
      throw error;
    }

    const result = await enqueueIngestionWithinLimits(gate.tenantId, input, INGESTION_LIMITS);
    if (!result.queued) {
      after(kickWorker);
      return noStoreJson({ error: limitMessage(result.reached) }, 429);
    }

    await recordServiceRun(
      SERVICE,
      "SUCCESS",
      Date.now() - started,
      1,
      `enqueue ${input.sourceKind} tenant=${gate.tenantId} ingestion=${result.ingestionId}`,
    );
    after(kickWorker);
    return noStoreJson({ ingestionId: result.ingestionId }, 202);
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
