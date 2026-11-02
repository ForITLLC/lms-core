import type { FC, ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import ShellRaw from "@/components/Shell";
import CoursePlayer from "@/components/CoursePlayer";
import { getSessionUser } from "@/lib/get-session";
import { getCourseBySlug } from "@/lib/db/courses";
import { stripBlock } from "@/lib/mobile/course";
import { resolveLearner, getSeenBlockIds } from "@/lib/db/progress";
import { ensureEnrollmentPinned, resolveLearnerVersion } from "@/lib/db/versions";
import { openRenewalIfDue } from "@/lib/db/renewal";
import { getTenantContentTokens } from "@/lib/db/tenants";
import { resolveCourseTokens } from "@/lib/tenant-tokens";
import { aiMarkingEnabled } from "@/lib/ai/grading/policy";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function CoursePage({ params }: PageProps) {
  const { slug } = await params;
  const session = await getSessionUser();
  if (!session) redirect(`/api/auth/login?returnTo=/learn/${encodeURIComponent(slug)}`);
  const tenantId = session.tenantId;
  if (!tenantId) redirect("/learn");

  // Resolve the learner before loading content so we can pin them to a
  // CourseVersion. First touch creates a learner row + an Enrollment pinned
  // to whatever's current; revisits reuse the existing pin so an in-flight
  // learner keeps seeing the version they started on even if the course has
  // been republished in between.
  const learner = await resolveLearner(
    tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );

  const preview = await getCourseBySlug(tenantId, slug, { learnerId: learner.learnerId });
  if (!preview) notFound();

  // A completed recurrent course whose certificate is near or past expiry
  // reopens here as the next cycle, before the version pin is read.
  await openRenewalIfDue(tenantId, learner.learnerId, preview.course.CourseId);
  const pinnedVersion = await resolveLearnerVersion(learner.learnerId, preview.course.CourseId);
  if (pinnedVersion) {
    await ensureEnrollmentPinned(tenantId, learner.learnerId, preview.course.CourseId, pinnedVersion);
  }

  const loaded = pinnedVersion && pinnedVersion !== preview.versionId
    ? await getCourseBySlug(tenantId, slug, { learnerId: learner.learnerId }, pinnedVersion)
    : preview;
  if (!loaded) notFound();

  // Resolve white-label {{...}} tokens (e.g. {{work_email_domain}}) against this
  // tenant's branding at render. Keeps content authored once, tenant-agnostic;
  // a branding edit flows through with no re-author.
  const tokens = await getTenantContentTokens(tenantId);
  const detail = resolveCourseTokens(loaded, tokens);
  // The player is a client component: strip every answer key and rubric the
  // way the iPhone payload does, so grading stays on the server.
  const lessons = detail.lessons.map((l) => ({ ...l, blocks: l.blocks.map(stripBlock) }));

  // Blocks this learner has already viewed on their pinned version. The player
  // uses this to (a) resume at the first unseen slide and (b) skip the dwell
  // gate on slides already in this set.
  const seenBlockIds = await getSeenBlockIds(
    learner.learnerId,
    detail.course.CourseId,
  );

  // Learners are told when their written answers are marked first by AI; the
  // setting is read only for a course that has any.
  const hasWrittenAnswers = lessons.some((l) =>
    l.blocks.some((b) => b.kind === "quiz" && b.questions.some((q) => q.kind === "short")),
  );
  const aiMarking = hasWrittenAnswers ? await aiMarkingEnabled(tenantId) : false;

  return (
    <Shell title={detail.course.Title}>
      <CoursePlayer
        course={detail.course}
        lessons={lessons}
        completedBlockIds={seenBlockIds}
        aiMarking={aiMarking}
      />
    </Shell>
  );
}
