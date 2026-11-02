import { z } from "zod";
import { getSessionUser } from "@/lib/get-session";
import { getSummaryIdentity, listSummaryManagers, setSummaryManager } from "@/lib/db/learning-summary";
import { recordError, recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function gate() {
  const session = await getSessionUser();
  if (!session) return { response: Response.json({ error: "Unauthenticated" }, { status: 401 }) };
  if (!session.tenantId) return { response: Response.json({ error: "No tenant" }, { status: 409 }) };
  const identity = await getSummaryIdentity(session.tenantId, session.email);
  if (identity?.Role !== "admin") return { response: Response.json({ error: "Forbidden" }, { status: 403 }) };
  return { tenantId: session.tenantId, email: session.email };
}

async function unavailable(error: unknown): Promise<Response> {
  await recordError("lms-summary-managers", error instanceof Error ? error.message : String(error), "ERROR").catch(() => undefined);
  return Response.json({ error: "Summary manager settings unavailable" }, { status: 503 });
}

export async function GET(): Promise<Response> {
  try {
    const access = await gate();
    if (access.response) return access.response;
    return Response.json({ mappings: await listSummaryManagers(access.tenantId) });
  } catch (error) { return unavailable(error); }
}

const Mapping = z.object({ manager_email: z.string().email(), learner_email: z.string().email(), enabled: z.boolean() }).strict();

export async function PUT(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const access = await gate();
    if (access.response) return access.response;
    const parsed = Mapping.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Provide manager_email, learner_email and enabled" }, { status: 400 });
    const { manager_email, learner_email, enabled } = parsed.data;
    if (!await setSummaryManager(access.tenantId, manager_email, learner_email, enabled, access.email)) {
      return Response.json({ error: "Manager or learner does not exist in this tenant" }, { status: 404 });
    }
    await recordServiceRun("lms-summary-managers", "SUCCESS", Date.now() - started, 1, `tenant=${access.tenantId} enabled=${enabled}`);
    return Response.json({ ok: true, mappings: await listSummaryManagers(access.tenantId) });
  } catch (error) { return unavailable(error); }
}
