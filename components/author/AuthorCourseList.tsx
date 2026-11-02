import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/ResponsiveTable";
import { StatusBadge } from "@/components/ui/StatusBadge";

// The shape of listAuthorCourses' rows, restated so this file never imports
// lib/db (app/author/author-pages.test.ts).
export interface AuthorCourseSummary {
  CourseId: string;
  Title: string;
  Slug: string;
  Status: string;
  VersionNumber: number | null;
  PublishedAt: Date | null;
  DraftRevision: number | null;
  DraftUpdatedAt: Date | null;
  DraftUpdatedBy: string | null;
}

const day = (value: Date | string) => new Date(value).toLocaleDateString();

function statusVariant(status: string) {
  if (status === "published") return "success" as const;
  if (status === "archived") return "warning" as const;
  return "neutral" as const;
}

const columns: ResponsiveColumn<AuthorCourseSummary>[] = [
  {
    key: "Title",
    header: "Course",
    primary: true,
    render: (c) => (
      <Link
        href={`/author/courses/${c.CourseId}`}
        prefetch={false}
        className="font-medium hover:underline"
        style={{ color: "var(--brand-primary)" }}
      >
        {c.Title || "Untitled course"}
      </Link>
    ),
  },
  {
    key: "Status",
    header: "Status",
    render: (c) => <StatusBadge status={c.Status.charAt(0).toUpperCase() + c.Status.slice(1)} variant={statusVariant(c.Status)} />,
  },
  {
    key: "VersionNumber",
    header: "Live version",
    className: "text-gray-600 tabular-nums",
    render: (c) => (c.VersionNumber ? `v${c.VersionNumber}${c.PublishedAt ? ` · ${day(c.PublishedAt)}` : ""}` : "Never published"),
  },
  {
    key: "DraftUpdatedAt",
    header: "Draft",
    className: "text-gray-600",
    render: (c) =>
      c.DraftUpdatedAt ? `Edited ${day(c.DraftUpdatedAt)}${c.DraftUpdatedBy ? ` by ${c.DraftUpdatedBy}` : ""}` : "No open draft",
  },
];

export default function AuthorCourseList({ courses }: { courses: AuthorCourseSummary[] }) {
  if (courses.length === 0) {
    return (
      <Card variant="white" padding="lg" className="text-center">
        <p className="text-gray-600">No courses yet. Start one above.</p>
      </Card>
    );
  }
  return (
    <Card variant="white" padding="lg">
      <div className="overflow-x-auto">
        <ResponsiveTable data={courses} columns={columns} rowKey={(c) => c.CourseId} collapseAt="md" />
      </div>
    </Card>
  );
}
