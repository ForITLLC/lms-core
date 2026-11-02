import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import AssignmentEditor, {
  type AssignmentRow,
  type CoursePickerOption,
  type LearnerPickerOption,
} from "@/components/AssignmentEditor";
import { getSessionUser } from "@/lib/get-session";
import { query } from "@/lib/db";
import { TENANT_VISIBLE_SCOPE } from "@/lib/db/course-scope";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

interface RawAssignment {
  AssignmentId: string;
  LearnerEmail: string;
  LearnerName: string;
  CourseSlug: string;
  CourseTitle: string;
  VersionNumber: number;
  AssignedBy: string;
  AssignedAt: Date;
  DueDate: Date | null;
  Note: string | null;
  Status: string;
}

export default async function AssignmentsAdminPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/assignments");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Course assignments">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const [learnerRows, courseRows, assignmentRows] = await Promise.all([
    query<{ Email: string; DisplayName: string }>(
      `SELECT Email, DisplayName FROM lms.Learner
        WHERE TenantId = @tenantId AND Status = 'active'
        ORDER BY DisplayName ASC`,
      { tenantId },
    ),
    query<{ Slug: string; Title: string; VersionNumber: number | null }>(
      `SELECT c.Slug, c.Title, v.VersionNumber
         FROM lms.Course c
         LEFT JOIN lms.CourseVersion v ON v.VersionId = c.CurrentVersionId
        WHERE ${TENANT_VISIBLE_SCOPE} AND c.Status = 'published'
        ORDER BY c.Title ASC`,
      { tenantId },
    ),
    query<RawAssignment>(
      `SELECT CONVERT(varchar(64), a.AssignmentId) AS AssignmentId,
              lr.Email       AS LearnerEmail,
              lr.DisplayName AS LearnerName,
              c.Slug         AS CourseSlug,
              c.Title        AS CourseTitle,
              v.VersionNumber,
              a.AssignedBy,
              a.AssignedAt,
              a.DueDate,
              a.Note,
              a.Status
         FROM lms.CourseAssignment a
         JOIN lms.Learner       lr ON lr.LearnerId = a.LearnerId
         JOIN lms.Course        c  ON c.CourseId   = a.CourseId
         JOIN lms.CourseVersion v  ON v.VersionId  = a.VersionId
        WHERE a.TenantId = @tenantId
        ORDER BY a.AssignedAt DESC`,
      { tenantId },
    ),
  ]);

  const learners: LearnerPickerOption[] = learnerRows.map((l) => ({
    email: l.Email,
    displayName: l.DisplayName,
  }));
  const courses: CoursePickerOption[] = courseRows.map((c) => ({
    slug: c.Slug,
    title: c.Title,
    currentVersionNumber: c.VersionNumber,
  }));
  const initialAssignments: AssignmentRow[] = assignmentRows.map((a) => ({
    AssignmentId: a.AssignmentId,
    LearnerEmail: a.LearnerEmail,
    LearnerName: a.LearnerName,
    CourseSlug: a.CourseSlug,
    CourseTitle: a.CourseTitle,
    VersionNumber: a.VersionNumber,
    AssignedBy: a.AssignedBy,
    AssignedAt: a.AssignedAt.toISOString(),
    DueDate: a.DueDate?.toISOString() ?? null,
    Note: a.Note,
    Status: a.Status,
  }));

  return (
    <Shell title="Course assignments">
      <p className="text-gray-700 mb-6 max-w-prose">
        Assign specific courses to specific learners. The assignment{" "}
        <span className="font-semibold">pins the course version</span> at the
        moment of assignment, so republishing a course later won&rsquo;t pull
        the assigned learner onto a different version mid-flight. To make a
        course available to everyone, use{" "}
        <a href="/admin/curriculum" className="underline">
          Curriculum management
        </a>{" "}
        instead. To see how far each learner has gotten on a course, open it
        from{" "}
        <a href="/admin/courses" className="underline">
          Courses
        </a>
        .
      </p>

      {learners.length === 0 || courses.length === 0 ? (
        <Card variant="white" padding="lg" className="text-center">
          <p className="text-gray-600">
            {learners.length === 0
              ? "No active learners in this tenant yet — sync HR first."
              : "No published courses in this tenant yet — seed the starter library or author a course first."}
          </p>
        </Card>
      ) : (
        <AssignmentEditor
          initialAssignments={initialAssignments}
          learners={learners}
          courses={courses}
        />
      )}
    </Shell>
  );
}
