import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import { resolveLearner } from "@/lib/db/progress";
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  if (!session.tenantId) return NextResponse.json({ error: "no_tenant" }, { status: 403 });

  const parsed = AnswerBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request", issues: parsed.error.issues }, { status: 400 });
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const result = await answerSlot(session.tenantId, learner.learnerId, parsed.data);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: STATUS[result.error] });
  return NextResponse.json(result.view, { headers: { "Cache-Control": "no-store" } });
}
