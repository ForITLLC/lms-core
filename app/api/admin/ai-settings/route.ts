import { z } from "zod";
import { noStoreJson, requireTenantAdmin, staffRouteFailure } from "@/lib/auth/staff-gate";
import { aiAuthoringEnabled } from "@/lib/ai/authoring/limits";
import { getAiSettings, setAiSettings, type AiSettings } from "@/lib/db/ai-settings";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SERVICE = "lms-ai-grading";

// The tenant admin's AI choices (slice A5a; the page is A5b). Today one: mark
// learners' written answers with AI, off until an admin turns it on. It works
// only where the platform also has AI on for the tenant (`available`), and
// changing it writes an AuditEvent in the same transaction. Admins of the
// session's own tenant only; an author or learner is 403.

const Body = z.object({ gradeWrittenAnswers: z.boolean() }).strict();

function present(settings: AiSettings, available: boolean) {
  return {
    gradeWrittenAnswers: settings.gradeWrittenAnswers,
    available,
    updatedBy: settings.updatedBy,
    updatedAt: settings.updatedAt,
  };
}

export async function GET(): Promise<Response> {
  try {
    const gate = await requireTenantAdmin();
    if (!gate.ok) return gate.response;
    const [settings, available] = await Promise.all([getAiSettings(gate.tenantId), aiAuthoringEnabled(gate.tenantId)]);
    return noStoreJson(present(settings, available));
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}

export async function PUT(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireTenantAdmin();
    if (!gate.ok) return gate.response;
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return noStoreJson({ error: "Send gradeWrittenAnswers as true or false." }, 400);
    const settings = await setAiSettings(gate.tenantId, body.data, gate.email);
    await recordServiceRun(
      SERVICE,
      "SUCCESS",
      Date.now() - started,
      1,
      `settings tenant=${gate.tenantId} gradeWrittenAnswers=${settings.gradeWrittenAnswers}`,
    );
    return noStoreJson(present(settings, await aiAuthoringEnabled(gate.tenantId)));
  } catch (error) {
    return staffRouteFailure(SERVICE, error);
  }
}
