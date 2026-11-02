import { NextResponse } from "next/server";
import { queryOne } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BUILD_SHA = process.env.BUILD_SHA || process.env.GIT_SHA || "dev";
const started = Date.now();

export async function GET() {
  const t0 = Date.now();
  let dbOk = false;
  let dbError: string | null = null;
  try {
    await queryOne<{ One: number }>(`SELECT 1 AS One`);
    dbOk = true;
  } catch (e) {
    dbError = e instanceof Error ? e.message : String(e);
  }
  return NextResponse.json(
    {
      ok: dbOk,
      db_ms: Date.now() - t0,
      db_error: dbError,
      build: BUILD_SHA,
      uptime_ms: Date.now() - started,
      ts: new Date().toISOString(),
    },
    { status: dbOk ? 200 : 503 },
  );
}
