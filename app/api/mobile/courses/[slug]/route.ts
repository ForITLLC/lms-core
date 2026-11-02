import { NextResponse } from "next/server";
import { requireMobileLearner } from "@/lib/mobile/learner";
import { getCourseBySlug } from "@/lib/db/courses";
import { getCourseProgress, getSeenBlockIds } from "@/lib/db/progress";
import { ensureEnrollmentPinned, resolveLearnerVersion } from "@/lib/db/versions";
import { openRenewalIfDue } from "@/lib/db/renewal";
import { getTenantContentTokens } from "@/lib/db/tenants";
import { resolveCourseTokens } from "@/lib/tenant-tokens";
import { getCourseCompletionState } from "@/lib/db/course-completion";
import { toMobileCourse } from "@/lib/mobile/course";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Mirrors app/learn/[slug]/page.tsx: the course is read inside the learner's
// tenant scope, a due renewal opens the next cycle, the learner is pinned to a
// CourseVersion on first open, and tenant {{tokens}} are resolved before the
// payload leaves the server.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const gate = await requireMobileLearner();
  if (!gate.ok) return gate.response;
  const { session, learner } = gate;
  const { slug } = await params;

  const preview = await getCourseBySlug(session.tenantId, slug, { learnerId: learner.learnerId });
  if (!preview) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await openRenewalIfDue(session.tenantId, learner.learnerId, preview.course.CourseId);
  const pinnedVersion = await resolveLearnerVersion(learner.learnerId, preview.course.CourseId);
  if (pinnedVersion) {
    await ensureEnrollmentPinned(session.tenantId, learner.learnerId, preview.course.CourseId, pinnedVersion);
  }
  const loaded = pinnedVersion && pinnedVersion !== preview.versionId
    ? await getCourseBySlug(session.tenantId, slug, { learnerId: learner.learnerId }, pinnedVersion)
    : preview;
  if (!loaded) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const detail = resolveCourseTokens(loaded, await getTenantContentTokens(session.tenantId));
  const [seen, progress, completion] = await Promise.all([
    getSeenBlockIds(learner.learnerId, detail.course.CourseId),
    getCourseProgress(learner.learnerId, detail.course.CourseId),
    getCourseCompletionState(session.tenantId, learner.learnerId, detail.course.CourseId),
  ]);
  if (!completion || completion.versionId?.toLowerCase() !== detail.versionId?.toLowerCase()) {
    return NextResponse.json({ error: "course_state_changed" }, { status: 409 });
  }
  return NextResponse.json(toMobileCourse(detail, seen, progress,
    completion.quizzes.filter((quiz) => quiz.submitted).map((quiz) => quiz.quizId),
    completion.courseCompleted));
}
