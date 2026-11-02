import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/get-session";
import { resolveAppUserId } from "@/lib/db/users";
import {
  listCatalogCourses,
  isSubscribableCatalogCourse,
  ownCourseUsesCatalogSlug,
  subscribeToCatalogCourse,
  unsubscribeFromCatalogCourse,
} from "@/lib/db/catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Shared-catalogue subscription management for a subscriber tenant. GET lists
// every ForIT catalogue course flagged with this tenant's opt-in state; POST
// subscribes; DELETE unsubscribes. Subscribing is gated server-side on
// isSubscribableCatalogCourse so a tenant can never opt into a non-catalogue
// or non-ForIT course.

const PostBody = z.object({ courseId: z.string().uuid() });

type StaffGate =
  | { ok: true; tenantId: string; email: string; appUserId: string }
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
  return { ok: true, tenantId: session.tenantId, email: session.email, appUserId };
}

export async function GET() {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  const courses = await listCatalogCourses(gate.tenantId);
  return NextResponse.json({ courses });
}

export async function POST(req: Request) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  let body: z.infer<typeof PostBody>;
  try {
    body = PostBody.parse(await req.json());
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid body" },
      { status: 400 },
    );
  }

  if (!(await isSubscribableCatalogCourse(body.courseId))) {
    return NextResponse.json(
      { error: "Course is not a published shared catalogue course" },
      { status: 400 },
    );
  }

  if (await ownCourseUsesCatalogSlug(gate.tenantId, body.courseId)) {
    return NextResponse.json(
      {
        error: "One of your courses already uses this course's address. Rename it before subscribing.",
        code: "slug_conflict",
      },
      { status: 409 },
    );
  }

  await subscribeToCatalogCourse(gate.tenantId, body.courseId, gate.email);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  const courseId = new URL(req.url).searchParams.get("courseId");
  if (!courseId || !z.string().uuid().safeParse(courseId).success) {
    return NextResponse.json(
      { error: "Missing or invalid ?courseId=" },
      { status: 400 },
    );
  }

  await unsubscribeFromCatalogCourse(gate.tenantId, courseId);
  return NextResponse.json({ ok: true });
}
