import { NextRequest, NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { emptyView, getOrCreateToday, viewSession } from "@/lib/drill/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The app's daily drill: the web learner route behind the device key. The
// payload never carries an answer key; a slot's key arrives only once that
// slot has been answered.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session, learner } = gate;
  const tz = new URL(req.url).searchParams.get("tz");
  const today = await getOrCreateToday(session.tenantId, learner.learnerId, tz);
  const view = today.session
    ? await viewSession(session.tenantId, learner.learnerId, today.session)
    : await emptyView(session.tenantId, learner.learnerId, today.timeZone, today.localDate);
  return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
}
