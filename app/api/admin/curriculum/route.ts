import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/get-session";
import {
  ensureDefaultCurriculum,
  setCurriculumCourse,
  removeCurriculumCourse,
  getDefaultCurriculumCourses,
} from "@/lib/db/curriculum";
import { queryOne } from "@/lib/db";
import { TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin endpoint: place a course in the tenant's default curriculum, set it
// mandatory/optional, or remove it. Sits under /api/admin (middleware-gated),
// with an explicit staff-role check mirroring the provision-DNS route.
export async function POST(req: Request) {
  let session;
  try {
    session = await requireSessionUser();
  } catch {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (session.role !== "admin" && session.role !== "author") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!session.tenantId) {
    return NextResponse.json({ error: "No tenant" }, { status: 400 });
  }

  let body: {
    courseId?: string;
    membership?: "excluded" | "optional" | "mandatory";
    orderIndex?: number;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { courseId, membership } = body;
  if (!courseId || !membership) {
    return NextResponse.json(
      { error: "courseId and membership required" },
      { status: 400 },
    );
  }

  // Tenant guard: the course must be the caller's own or a catalogue course
  // the caller subscribes to before it can be wired into the curriculum.
  const owned = await queryOne<{ CourseId: string }>(
    `SELECT c.CourseId FROM lms.Course c
      WHERE c.CourseId = @courseId AND ${TENANT_VISIBLE_SCOPE}`,
    { courseId, tenantId: session.tenantId },
  );
  if (!owned) {
    return NextResponse.json({ error: "Course not in tenant" }, { status: 404 });
  }

  const curriculum = await ensureDefaultCurriculum(session.tenantId);
  if (membership === "excluded") {
    await removeCurriculumCourse(curriculum.curriculumId, courseId);
  } else {
    await setCurriculumCourse(curriculum.curriculumId, courseId, {
      isMandatory: membership === "mandatory",
      orderIndex:
        typeof body.orderIndex === "number" && Number.isFinite(body.orderIndex)
          ? Math.trunc(body.orderIndex)
          : 0,
    });
  }

  const courses = await getDefaultCurriculumCourses(session.tenantId);
  return NextResponse.json({ courses });
}
