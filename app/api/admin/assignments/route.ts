import { NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/get-session";
import {
  AssignmentError,
  listAssignmentsForCourse,
  listAssignmentsForLearner,
  upsertCourseAssignment,
} from "@/lib/db/assignments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Manual course assignment. Admin / author picks a learner email and a course
// slug; the assignment pins the course's CurrentVersionId at the moment of
// assignment so future republishes don't yank the assigned learner onto a
// new version. Idempotent on (tenant, learner, course): re-POSTing the same
// pair updates the due date / note without re-pinning the version. A course
// reached only through a marketplace entitlement takes a seat and pins the
// entitlement's version; with every seat taken the answer is 409 no_seats.
//
// GET ?learnerEmail=… → assignments for that learner
// GET ?courseSlug=…   → assignments for that course

const PostBody = z.object({
  learnerEmail: z.string().email(),
  courseSlug: z.string().regex(/^[a-z0-9-]+$/),
  dueDate: z.string().datetime().optional().nullable(),
  note: z.string().max(1024).optional().nullable(),
});

type StaffGate =
  | { ok: true; tenantId: string; email: string }
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
  return { ok: true, tenantId: session.tenantId, email: session.email };
}

export async function GET(req: Request) {
  const gate = await requireStaff();
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const learnerEmail = url.searchParams.get("learnerEmail");
  const courseSlug = url.searchParams.get("courseSlug");
  if (!learnerEmail && !courseSlug) {
    return NextResponse.json(
      { error: "Provide ?learnerEmail= or ?courseSlug=" },
      { status: 400 },
    );
  }

  const assignments = learnerEmail
    ? await listAssignmentsForLearner(gate.tenantId, learnerEmail)
    : await listAssignmentsForCourse(gate.tenantId, courseSlug as string);
  return NextResponse.json({ assignments });
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

  try {
    const result = await upsertCourseAssignment({
      tenantId: gate.tenantId,
      learnerEmail: body.learnerEmail,
      courseSlug: body.courseSlug,
      assignedBy: gate.email,
      dueDate: body.dueDate ? new Date(body.dueDate) : null,
      note: body.note ?? null,
    });
    return NextResponse.json({ assignment: result }, { status: result.created ? 201 : 200 });
  } catch (err) {
    if (err instanceof AssignmentError) {
      const status = err.code === "course_not_published" || err.code === "no_seats" || err.code === "learner_left" ? 409 : 404;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Assignment failed" },
      { status: 500 },
    );
  }
}
