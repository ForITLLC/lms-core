import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/get-session";
import {
  resolveLearner,
  ensureEnrollment,
  markAllBlocksComplete,
} from "@/lib/db/progress";
import { getCourseCompletionState } from "@/lib/db/course-completion";
import { finishCourseIfDone, pendingPackageBlocks } from "@/lib/db/course-finish";
import { getCourseQuizGate } from "@/lib/db/quizzes";
import { pendingPackageRefusal, unsubmittedQuizRefusal } from "@/lib/completion-gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Course-completion endpoint. CoursePlayer calls this once the learner reaches
// the final slide. Reaching that slide means every slide was traversed, so we
// mark all blocks done with one set-based MERGE rather than trusting that each
// per-slide beacon landed — then mint the certificate. A package block is not
// a slide the learner reads: until its launchable is satisfied the course
// answers 409 package_incomplete, before any progress write.
export async function POST(req: Request) {
  const session = await getSessionUser();
  if (!session?.tenantId) {
    return NextResponse.json({ error: "Unauthenticated" }, { status: 401 });
  }

  let body: { courseId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!body.courseId) {
    return NextResponse.json({ error: "courseId required" }, { status: 400 });
  }
  const { courseId } = body;

  const learner = await resolveLearner(
    session.tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const completion = await getCourseCompletionState(session.tenantId, learner.learnerId, courseId);
  if (!completion) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const rawGate = await getCourseQuizGate(learner.learnerId, courseId);
  const eligibleIds = new Set(completion.quizzes.map((quiz) => quiz.quizId.toLowerCase()));
  const eligibleScores = rawGate.quizzes.filter((quiz) => eligibleIds.has(quiz.quizId.toLowerCase()));
  const passedIds = new Set(eligibleScores.filter((quiz) => quiz.passed).map((quiz) => quiz.quizId.toLowerCase()));
  const gate = {
    quizzes: eligibleScores,
    totalQuizzes: eligibleIds.size,
    passedQuizzes: passedIds.size,
    passed: [...eligibleIds].every((id) => passedIds.has(id)),
  };
  const unsubmitted = unsubmittedQuizRefusal(completion.quizzes);
  if (unsubmitted) return NextResponse.json(unsubmitted, { status: 409 });
  if (!(await ensureEnrollment(session.tenantId, learner.learnerId, courseId))) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  const unfinished = pendingPackageRefusal(await pendingPackageBlocks(session.tenantId, learner.learnerId, courseId));
  if (unfinished) return NextResponse.json(unfinished, { status: 409 });
  await markAllBlocksComplete(learner.learnerId, courseId);

  return NextResponse.json(
    await finishCourseIfDone(session.tenantId, learner.learnerId, learner.displayName, courseId, gate),
  );
}
