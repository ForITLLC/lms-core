import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import CurriculumEditor, { type EditorCourse } from "@/components/CurriculumEditor";
import { getSessionUser } from "@/lib/get-session";
import { listCoursesForTenant } from "@/lib/db/courses";
import { getDefaultCurriculumCourses } from "@/lib/db/curriculum";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function CurriculumAdminPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/curriculum");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Curriculum">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  // Every tenant course, draft or published, joined to its default-curriculum
  // membership. Courses absent from the curriculum default to "excluded".
  const [allCourses, curriculumCourses] = await Promise.all([
    listCoursesForTenant(tenantId, "operator", { includeDrafts: true }),
    getDefaultCurriculumCourses(tenantId),
  ]);

  const membershipByCourse = new Map(
    curriculumCourses.map((c) => [
      c.CourseId,
      { mandatory: c.IsMandatory, orderIndex: c.OrderIndex },
    ]),
  );

  const editorCourses: EditorCourse[] = allCourses.map((c) => {
    const m = membershipByCourse.get(c.CourseId);
    return {
      courseId: c.CourseId,
      title: c.Title,
      status: c.Status,
      category: null,
      membership: !m ? "excluded" : m.mandatory ? "mandatory" : "optional",
      orderIndex: m?.orderIndex ?? 0,
    };
  });

  return (
    <Shell title="Curriculum management">
      <p className="text-gray-700 mb-6 max-w-prose">
        The default curriculum is what every learner in your organization is
        measured against. <span className="font-semibold">Mandatory</span> courses
        are required training; <span className="font-semibold">optional</span> courses
        are recommended but not enforced. Order controls how courses are listed.
      </p>

      {editorCourses.length === 0 ? (
        <Card variant="white" padding="lg" className="text-center">
          <p className="text-gray-600">
            No courses exist for this tenant yet. Author or seed a course first.
          </p>
        </Card>
      ) : (
        <CurriculumEditor initial={editorCourses} />
      )}
    </Shell>
  );
}
