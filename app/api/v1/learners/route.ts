import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api/bearer";
import { withApiLogging } from "@/lib/api/handler";
import { listLearners } from "@/lib/api/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withApiLogging("list_learners", async (req: Request) => {
  const gate = await requireApiKey(req);
  if (!gate.ok) return gate.response;
  return NextResponse.json({ learners: await listLearners(gate.ctx.tenantId) });
});
