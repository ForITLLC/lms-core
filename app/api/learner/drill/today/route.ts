import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { resolveLearner } from "@/lib/db/progress";
import { emptyView, getOrCreateToday, viewSession } from "@/lib/drill/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Today's drill for the signed-in learner, created on first request. The
// payload never carries an answer key: questions are stripped server-side
// and the key is revealed per slot only after that slot has been answered.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!session.tenantId) return NextResponse.json({ error: "no_tenant" }, { status: 403 });

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const tz = new URL(req.url).searchParams.get("tz");
  const today = await getOrCreateToday(session.tenantId, learner.learnerId, tz);
  const view = today.session
    ? await viewSession(session.tenantId, learner.learnerId, today.session)
    : await emptyView(session.tenantId, learner.learnerId, today.timeZone, today.localDate);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
