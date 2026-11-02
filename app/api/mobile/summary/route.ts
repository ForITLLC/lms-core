import { getSessionUser } from "@/lib/get-session";
import { getLearningSummary } from "@/lib/db/learning-summary";
import { recordError } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const session = await getSessionUser();
  if (!session) return Response.json({ error: "Unauthenticated" }, { status: 401 });
  if (!session.tenantId) return Response.json({ error: "No tenant" }, { status: 409 });
  try {
    return Response.json(await getLearningSummary(session.tenantId, session.email));
  } catch (error) {
    await recordError("lms-summary", error instanceof Error ? error.message : String(error), "ERROR").catch(() => undefined);
    return Response.json({ error: "Learning summary unavailable" }, { status: 503 });
  }
}
