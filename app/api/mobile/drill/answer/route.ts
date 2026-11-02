import { NextRequest, NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { AnswerBody } from "@/lib/drill/schema";
import { answerSlot, type AnswerError } from "@/lib/drill/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUS: Record<AnswerError, number> = {
  not_found: 404,
  completed: 409,
  bad_slot: 400,
  gone: 410,
};

// One drill answer from the app, graded server-side exactly as the web's.
// The answer comes back as today's whole drill, with that slot's reveal.
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session, learner } = gate;

  const parsed = AnswerBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }

  const result = await answerSlot(session.tenantId, learner.learnerId, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: STATUS[result.error] });
  return NextResponse.json(result.view, { headers: { "Cache-Control": "no-store" } });
}
