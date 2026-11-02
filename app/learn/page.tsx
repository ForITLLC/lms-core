import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import ComingSoon from "@/components/ComingSoon";
import CourseCatalog from "@/components/CourseCatalog";
import { getSessionUser } from "@/lib/get-session";
import { listCoursesForTenant } from "@/lib/db/courses";
import { resolveLearner } from "@/lib/db/progress";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function LearnPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/learn");
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Course catalog">
        <ComingSoon
          title="No tenant resolved"
          description="Your session isn't bound to a tenant yet. Sign out and back in, or contact your administrator."
        />
      </Shell>
    );
  }

  const learner = await resolveLearner(
    tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );
  const courses = await listCoursesForTenant(tenantId, { learnerId: learner.learnerId });

  return (
    <Shell title="Course catalog">
      {courses.length === 0 ? (
        <Card variant="white" padding="lg" className="text-center">
          <h2 className="text-xl font-semibold" style={{ color: "var(--brand-primary)" }}>
            No published courses yet
          </h2>
          <p className="mt-3 text-gray-600 max-w-prose mx-auto">
            Once an author publishes a course it will show up here.
          </p>
        </Card>
      ) : (
        <CourseCatalog courses={courses} />
      )}
    </Shell>
  );
}
