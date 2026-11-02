import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/get-session";
import { resolveAppUserId } from "@/lib/db/users";
import { setCourseCatalogPublish } from "@/lib/db/catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Publish (or unpublish) one of the caller's own courses: to the shared ForIT
// catalogue for `forit`, to the marketplace for a publisher tenant.
// setCourseCatalogPublish is double-gated server-side: the UPDATE only
// matches when the caller owns the course AND the caller is `forit` or a
// publisher tenant — rows affected 0 means neither holds, so 403.

const Body = z.object({ isCatalog: z.boolean() });

interface RouteParams {
  params: Promise<{ courseId: string }>;
}

type StaffGate =
  | { ok: true; tenantId: string; appUserId: string }
  | { ok: false; response: NextResponse };

async function requireStaff(): Promise<StaffGate> {
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return { ok: false, response: NextResponse.json({ error: "Unauthenticated" }, { status: 401 }) };
  }
  if (session.role !== "admin" && session.role !== "author") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  if (!session.tenantId) {
    return { ok: false, response: NextResponse.json({ error: "No tenant" }, { status: 400 }) };
  }
  const appUserId = await resolveAppUserId(session.tenantId, session.email);
  if (!appUserId) {
    return { ok: false, response: NextResponse.json({ error: "Unknown app user" }, { status: 400 }) };
  }
  return { ok: true, tenantId: session.tenantId, appUserId };
}

export async function PUT(req: Request, { params }: RouteParams) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }

  const { courseId } = await params;
  const affected = await setCourseCatalogPublish(
    gate.tenantId,
    courseId,
    body.isCatalog,
  );
  if (affected === 0) {
    return NextResponse.json(
      { error: "Only the platform tenant or a publisher tenant can publish its own courses" },
      { status: 403 },
    );
  }
  return NextResponse.json({ ok: true });
}
