import { NextResponse } from "next/server";
import { getSessionUser, type LmsSession } from "@/lib/get-session";
import { resolveLearner, type LearnerRef } from "@/lib/db/progress";

export type MobileLearnerGate =
  | { ok: true; session: LmsSession & { tenantId: string }; learner: LearnerRef }
  | { ok: false; response: NextResponse };

// Every /api/mobile read starts here: a live device key (or cookie) bound to a
// tenant, and the learner row that every learner query is keyed by.
export async function requireMobileLearner(): Promise<MobileLearnerGate> {
  const session = await getSessionUser();
  if (!session) {
    return { ok: false, response: NextResponse.json({ error: "unauthenticated" }, { status: 401 }) };
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return { ok: false, response: NextResponse.json({ error: "no_tenant" }, { status: 409 }) };
  }
  const learner = await resolveLearner(
    tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  return { ok: true, session: { ...session, tenantId }, learner };
}
