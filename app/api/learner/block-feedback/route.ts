import { after, NextResponse } from "next/server";
import { z } from "zod";
import { getSessionUser } from "@/lib/get-session";
import { queryOne } from "@/lib/db";
import { seatHeldBy } from "@/lib/db/course-scope";
import { resolveLearner } from "@/lib/db/progress";
import {
  getBlockFeedbackForLearnerBlock,
  upsertBlockFeedback,
  type BlockFeedbackRow,
} from "@/lib/db/blockFeedback";
import { sendFeedbackToSupport } from "@/lib/support-intake";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PostBody = z.object({
  courseSlug: z.string().min(1).max(128),
  blockId: z.string().uuid(),
  comment: z.string().min(1).max(4000),
});

// Course scope is the catalogue union (migration 0014): the learner's own
// tenant courses plus any subscribed catalogue course, and an entitled course
// only while the learner holds its seat. The block
// feedback row itself is still keyed to the learner's tenant — only the
// course content is shared. The own course wins a slug collision.
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

// Confirms the block belongs to the named course (and therefore the tenant).
// Without this a learner could attach a note to a block from another tenant's
// course, leaking that lesson's title into this tenant's author inbox.
async function blockBelongsToCourse(
  courseId: string,
  blockId: string,
): Promise<boolean> {
  const row = await queryOne<{ Ok: number }>(
    `SELECT 1 AS Ok
       FROM lms.Block b
       JOIN lms.Lesson l ON l.LessonId = b.LessonId
      WHERE b.BlockId = @blockId AND l.CourseId = @courseId`,
    { courseId, blockId },
  );
  return row !== null;
}

function serialize(row: BlockFeedbackRow) {
  return {
    blockFeedbackId: row.BlockFeedbackId,
    blockId: row.BlockId,
    comment: row.Comment,
    resolved: row.Resolved,
    createdAt: row.CreatedAt,
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
  const parsedBlockId = z
    .string()
    .uuid()
    .safeParse(url.searchParams.get("blockId"));
  if (!parsedBlockId.success) {
    return NextResponse.json(
      { error: "Valid blockId required" },
      { status: 400 },
    );
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const existing = await getBlockFeedbackForLearnerBlock(
    session.tenantId,
    learner.learnerId,
    parsedBlockId.data,
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
  const { courseSlug, blockId } = parsed.data;
  const comment = parsed.data.comment.trim();
  if (comment.length === 0) {
    return NextResponse.json({ error: "Comment is empty" }, { status: 400 });
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
  if (!(await blockBelongsToCourse(courseId, blockId))) {
    return NextResponse.json({ error: "Block not in course" }, { status: 404 });
  }
  const row = await upsertBlockFeedback(
    session.tenantId,
    learner.learnerId,
    courseId,
    blockId,
    comment,
  );
  const tenantId = session.tenantId;
  after(() => sendFeedbackToSupport(tenantId, { email: session.email, name: session.name },
    { kind: "slide", courseId, blockId, comment }));
  return NextResponse.json({ feedback: serialize(row) });
}
