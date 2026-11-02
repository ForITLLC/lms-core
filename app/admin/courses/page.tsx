import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/ResponsiveTable";
import ShellRaw from "@/components/Shell";
import { getSessionUser } from "@/lib/get-session";
import { listCoursesForTenant, type CourseListRow } from "@/lib/db/courses";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

function StatusBadge({ status }: { status: string }) {
  const published = status === "published";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
        published ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-700"
      }`}
    >
      {published ? "Published" : status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

const columns: ResponsiveColumn<CourseListRow>[] = [
  {
    key: "Title",
    header: "Course",
    primary: true,
    render: (c) => (
      <Link
        href={`/admin/courses/${c.Slug}`}
        prefetch={false}
        className="font-medium hover:underline"
        style={{ color: "var(--brand-primary)" }}
      >
        {c.Title}
      </Link>
    ),
  },
  {
    key: "Category",
    header: "Category",
    className: "text-gray-600",
    render: (c) => c.Category ?? "—",
  },
  {
    key: "OwnerName",
    header: "Owner",
    className: "text-gray-600",
    render: (c) => c.OwnerName ?? "—",
  },
  {
    key: "Status",
    header: "Status",
    render: (c) => <StatusBadge status={c.Status} />,
  },
  {
    key: "UpdatedAt",
    header: "Updated",
    align: "right",
    className: "text-gray-500 tabular-nums",
    render: (c) => new Date(c.UpdatedAt).toLocaleDateString(),
  },
];

export default async function AdminCoursesPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/courses");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Courses">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const courses = await listCoursesForTenant(tenantId, "operator", { includeDrafts: true });

  return (
    <Shell title="Courses">
      <p className="text-gray-700 mb-6 max-w-prose">
        Open a course to see its version history, every enrolled learner&rsquo;s
        progress, and the feedback learners have left.
      </p>

      {courses.length === 0 ? (
        <Card variant="white" padding="lg" className="text-center">
          <p className="text-gray-600">
            No courses in this tenant yet — seed the starter library or author a
            course first.
          </p>
        </Card>
      ) : (
        <Card variant="white" padding="lg">
          <div className="overflow-x-auto">
            <ResponsiveTable
              data={courses}
              columns={columns}
              rowKey={(c) => c.CourseId}
              collapseAt="md"
            />
          </div>
        </Card>
      )}
    </Shell>
  );
}
