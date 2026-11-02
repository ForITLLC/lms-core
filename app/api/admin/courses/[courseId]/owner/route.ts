import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/get-session";
import { resolveAppUserId } from "@/lib/db/users";
import { setCourseOwner, type CourseOwner } from "@/lib/db/courses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sets (or clears) a course's owning instructor or group. Tenant-scoped:
// setCourseOwner only matches a course the caller's tenant owns, so a
// subscribed catalogue course can never be re-owned here (rows affected 0).

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string().uuid() }),
  z.object({
    kind: z.literal("group"),
    groupId: z.string().trim().min(1).max(64),
    groupName: z.string().trim().min(1).max(256),
  }),
  z.object({ kind: z.literal("none") }),
]);

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

  let body: CourseOwner;
  try {
    body = Body.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }

  const { courseId } = await params;
  const affected = await setCourseOwner(gate.tenantId, courseId, body);
  if (affected === 0) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
