import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GIT_SHA is inlined at build time by next.config.mjs `env`, so this reports the
// commit the SERVED bundle was built from — not a runtime appsetting a stale
// worker could still be holding. The fleet verify-live-deploy gate (WO #143)
// asserts this equals the just-deployed github.sha, failing red on a warm/old
// instance. Public route (see auth-config publicPaths) so the CI poll needs no
// session. Falls back to "dev" for local runs where GIT_SHA is unset.
const GIT_SHA = process.env.GIT_SHA ?? "dev";

export function GET() {
  return NextResponse.json({ sha: GIT_SHA });
}
