import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import CatalogueManager, {
  type CatalogueCourse,
} from "@/components/CatalogueManager";
import { getSessionUser } from "@/lib/get-session";
import { listCatalogCourses } from "@/lib/db/catalogue";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function AdminCataloguePage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/catalogue");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Shared catalogue">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const rows = await listCatalogCourses(tenantId);
  const courses: CatalogueCourse[] = rows.map((r) => ({
    courseId: r.CourseId,
    title: r.Title,
    slug: r.Slug,
    description: r.Description,
    category: r.Category,
    lessonCount: r.LessonCount,
    isSubscribed: r.IsSubscribed,
  }));

  return (
    <Shell title="Shared catalogue">
      <p className="text-gray-700 mb-6 max-w-prose">
        Subscribe to courses from the shared catalogue. Subscribed courses
        appear read-only in your learners&rsquo; dashboard and{" "}
        <span className="font-medium">Learn</span> library — your learners&rsquo;
        progress and certificates stay in your tenant.
      </p>
      <Card variant="white" padding="lg">
        <CatalogueManager initialCourses={courses} />
      </Card>
    </Shell>
  );
}
