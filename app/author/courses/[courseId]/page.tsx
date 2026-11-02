import type { FC, ReactNode } from "react";
import { notFound } from "next/navigation";
import ShellRaw from "@/components/Shell";
import CourseEditor from "@/components/author/CourseEditor";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import { requireAuthorPage } from "@/lib/auth/author-page";
import { getCourseIngestion } from "@/lib/db/ingestions";
import { recordError } from "@/lib/logging";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

const COURSE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ courseId: string }>;
}

// The editor loads the draft through /api/author/courses/[courseId]/draft,
// which answers 404 for a course outside the session's tenant. A course an AI
// authoring job made carries a banner naming its source; a failed lookup only
// loses the banner, never the editor.
export default async function AuthorCoursePage({ params }: PageProps) {
  const { courseId } = await params;
  const access = await requireAuthorPage(`/author/courses/${courseId}`);
  if (!access.ok) {
    return (
      <Shell title="Course editor">
        <NoTenantNotice />
      </Shell>
    );
  }
  if (!COURSE_ID.test(courseId)) notFound();
  const id = courseId.toLowerCase();
  const job = await getCourseIngestion(access.tenantId, id).catch(async (error: unknown) => {
    await recordError("lms-author", `course.aiOrigin course=${id}: ${error instanceof Error ? error.message : String(error)}`, "WARNING");
    return null;
  });
  const aiOrigin = job ? { source: { kind: job.sourceKind, ref: job.sourceRef }, warnings: job.warnings } : null;

  return (
    <Shell title="Course editor">
      <CourseEditor courseId={id} aiOrigin={aiOrigin} />
    </Shell>
  );
}
