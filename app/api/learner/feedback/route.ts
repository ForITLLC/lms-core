import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/get-session";
import { queryOne } from "@/lib/db";
import { seatHeldBy } from "@/lib/db/course-scope";
import { resolveLearner } from "@/lib/db/progress";
import {
  getCourseFeedbackForLearner,
  upsertCourseFeedback,
  type CourseFeedbackRow,
} from "@/lib/db/feedback";
import { sendFeedbackToSupport } from "@/lib/support-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostBody = z.object({
  courseSlug: z.string().min(1).max(128),
  rating: z.number().int().min(1).max(5),
  comment: z.string().max(4000).nullish(),
});

// Course scope is the catalogue union (migration 0014): the learner's own
// tenant courses plus any subscribed catalogue course, and an entitled course
// only while the learner holds its seat. The feedback row
// itself is still keyed to the learner's tenant — only the course content is
// shared. The own course wins a slug collision.
async function resolveCourseIdBySlug(
  tenantId: string,
  learnerId: string,
  slug: string,
): Promise<string | null> {
  const row = await queryOne<{ CourseId: string }>(
    `SELECT TOP 1 CONVERT(varchar(64), c.CourseId) AS CourseId
       FROM lms.Course c
      WHERE c.Slug = @slug
        AND (
          c.TenantId = @tenantId
          OR c.CourseId IN (
            SELECT CourseId FROM lms.CatalogSubscription
             WHERE TenantId = @tenantId
          )
          OR ${seatHeldBy()}
        )
      ORDER BY CASE WHEN c.TenantId = @tenantId THEN 0 ELSE 1 END`,
    { tenantId, learnerId, slug },
  );
  return row?.CourseId ?? null;
}

function serialize(row: CourseFeedbackRow) {
  return {
    feedbackId: row.FeedbackId,
    rating: row.Rating,
    comment: row.Comment,
    submittedAt: row.SubmittedAt,
    updatedAt: row.UpdatedAt,
  };
}

export async function GET(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (!session.tenantId) {
    return NextResponse.json({ error: "No tenant binding" }, { status: 403 });
  }

  const url = new URL(req.url);
  const courseSlug = url.searchParams.get("courseSlug");
  if (!courseSlug) {
    return NextResponse.json({ error: "courseSlug required" }, { status: 400 });
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const courseId = await resolveCourseIdBySlug(session.tenantId, learner.learnerId, courseSlug);
  if (!courseId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const existing = await getCourseFeedbackForLearner(
    session.tenantId,
    learner.learnerId,
    courseId,
  );
  return NextResponse.json({ feedback: existing ? serialize(existing) : null });
}

export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }
  if (!session.tenantId) {
    return NextResponse.json({ error: "No tenant binding" }, { status: 403 });
  }

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PostBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { courseSlug, rating } = parsed.data;
  const rawComment = parsed.data.comment ?? null;
  const trimmed = typeof rawComment === "string" ? rawComment.trim() : null;
  const comment = trimmed && trimmed.length > 0 ? trimmed : null;

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const courseId = await resolveCourseIdBySlug(session.tenantId, learner.learnerId, courseSlug);
  if (!courseId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const row = await upsertCourseFeedback(
    session.tenantId,
    learner.learnerId,
    courseId,
    rating,
    comment,
  );
  const tenantId = session.tenantId;
  after(() => sendFeedbackToSupport(tenantId, { email: session.email, name: session.name },
    { kind: "course", courseId, rating, comment }));
  return NextResponse.json({ feedback: serialize(row) });
}
