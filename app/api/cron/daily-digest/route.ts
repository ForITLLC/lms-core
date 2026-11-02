import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The separate learning summary email is retired (Ben, 2026-10-29): due items reach people through
// the one ForIT Daily email and the single iOS summary notification, never a mail of their own.
export async function POST(req: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response("Forbidden", { status: 403 });
  return Response.json({ ok: false, error: "The learning summary email is retired; nothing was sent" }, { status: 410 });
}
