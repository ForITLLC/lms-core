import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import {
  resolveLearner,
  ensureEnrollment,
  courseBlockKind,
  recordBlockProgress,
  getCourseProgress,
} from "@/lib/db/progress";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Per-slide progress beacon. CoursePlayer POSTs one of these the first time a
// learner lands on a content block. courseBlockKind rejects a forged blockId
// before any write, so a beacon can only ever mark a block of the course it
// claims to be in. A package block is refused the same way: only its satisfied
// launchable may mark it done, and the iPhone app beacons every block it shows.
export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session?.tenantId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: { courseId?: string; blockId?: string; seconds?: number };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { courseId, blockId } = body;
  if (!courseId || !blockId) {
    return NextResponse.json(
      { error: "courseId and blockId required" },
      { status: 400 },
    );
  }
  const seconds =
    typeof body.seconds === "number" && Number.isFinite(body.seconds)
      ? Math.max(0, Math.trunc(body.seconds))
      : 0;

  const kind = await courseBlockKind(blockId, courseId);
  if (kind === null) {
    return NextResponse.json({ error: "Block not in course" }, { status: 400 });
  }
  if (kind === "package") {
    return NextResponse.json(
      { error: "A package block is completed by its activity", code: "package_block" },
      { status: 400 },
    );
  }

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
  );
  if (!(await ensureEnrollment(session.tenantId, learner.learnerId, courseId))) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  await recordBlockProgress(learner.learnerId, blockId, seconds);

  const progress = await getCourseProgress(learner.learnerId, courseId);
  return NextResponse.json({ progress });
}
