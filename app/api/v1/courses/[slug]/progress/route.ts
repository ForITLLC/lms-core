import { NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api/bearer";
import { withApiLogging } from "@/lib/api/handler";
import { getProgress } from "@/lib/api/reads";
import { notFound } from "@/lib/api/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ slug: string }>;
}

export const GET = withApiLogging("get_progress", async (req: Request, { params }: RouteParams) => {
  const gate = await requireApiKey(req);
  if (!gate.ok) return gate.response;
  const { slug } = await params;
  const progress = await getProgress(gate.ctx.tenantId, slug);
  if (!progress) return notFound(`No course with slug "${slug}"`);
  return NextResponse.json(progress);
});
