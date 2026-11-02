import { createLogoutHandler } from "@foritllc/auth";
import { NextResponse } from "next/server";
import { authConfig } from "@/lib/auth-config";

const handler = createLogoutHandler(authConfig);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Defense against Next.js RSC / link-prefetch silently logging users out.
// Any <Link href="/api/auth/logout"> without prefetch={false} triggers a
// background GET on mount, wiping the cookie before the user clicks anything.
// Reproduced in production 2026-05-17 (Shell.tsx desktop Sign out link).
//
// `req` typed as `any` to dodge the NextRequest identity mismatch between
// forit-Common's pinned `next` and the app's — same workaround used in
// lib/auth-config.ts.
export async function GET(req: any) {
  const h = req.headers;
  const url = new URL(req.url);
  const isPrefetch =
    h.get("next-router-prefetch") === "1" ||
    h.get("purpose") === "prefetch" ||
    (h.get("sec-purpose") ?? "").includes("prefetch") ||
    h.get("x-middleware-prefetch") === "1" ||
    !!h.get("rsc") ||
    url.searchParams.has("_rsc");
  if (isPrefetch) {
    return new NextResponse(null, { status: 204 });
  }
  return handler(req);
}
