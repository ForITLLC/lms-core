import { NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { mobileProfile } from "@/lib/mobile/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session } = gate;
  const profile = await mobileProfile({
    tenantId: session.tenantId,
    email: session.email,
    name: session.name ?? session.email,
    role: session.role ?? "learner",
  });
  return NextResponse.json(profile);
}
