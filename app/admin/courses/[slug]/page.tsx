import type { FC, ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/ResponsiveTable";
import ShellRaw from "@/components/Shell";
import Avatar from "@/components/Avatar";
import { getSessionUser } from "@/lib/get-session";
import {
  resolveCourseAdmin,
  listCourseVersions,
  getCourseLearnerStatus,
  type CourseLearnerStatus,
  type CourseVersionSummary,
} from "@/lib/db/courseAdmin";
import { getCourseFeedbackSummary } from "@/lib/db/feedback";
import { getBlockFeedbackForCourse } from "@/lib/db/blockFeedback";
import { listAppUsers } from "@/lib/db/users";
import { isForitTenant } from "@/lib/db/catalogue";
import CourseOwnerPicker from "@/components/CourseOwnerPicker";
import CatalogPublishToggle from "@/components/CatalogPublishToggle";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
}

function fmtDate(d: Date): string {
  return new Date(d).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDay(d: Date): string {
  return new Date(d).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h2
      className="text-lg font-semibold mb-3 mt-8"
      style={{ color: "var(--brand-primary)" }}
    >
      {children}
    </h2>
  );
}

function Stars({ value }: { value: number }) {
  const rounded = Math.round(value);
  return (
    <span aria-label={`${value.toFixed(1)} out of 5`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          style={{ color: n <= rounded ? "var(--brand-accent, #f5b400)" : "#d1d5db" }}
        >
          {n <= rounded ? "★" : "☆"}
        </span>
      ))}
    </span>
  );
}

function LearnerStatusBadge({ row }: { row: CourseLearnerStatus }) {
  if (row.renewing) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-xs font-medium">
        Renewing
      </span>
    );
  }
  if (row.completedAt) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded bg-green-100 text-green-800 text-xs font-medium">
        Completed
      </span>
    );
  }
  if (row.doneBlocks > 0) {
    return (
      <span className="inline-block px-1.5 py-0.5 rounded bg-yellow-100 text-yellow-800 text-xs font-medium">
        In progress
      </span>
    );
  }
  return (
    <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 text-xs font-medium">
      Not started
    </span>
  );
}

const versionColumns: ResponsiveColumn<CourseVersionSummary>[] = [
  {
    key: "versionNumber",
    header: "Version",
    primary: true,
    className: "font-medium text-gray-900",
    render: (v) => (
      <>
        v{v.versionNumber}
        {v.isCurrent && (
          <span className="ml-2 inline-block px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 text-xs font-medium">
            Current
          </span>
        )}
      </>
    ),
  },
  {
    key: "publishedAt",
    header: "Published",
    className: "text-gray-600",
    render: (v) => fmtDate(v.publishedAt),
  },
  {
    key: "publishedBy",
    header: "By",
    className: "text-gray-600",
  },
  {
    key: "lessonCount",
    header: "Lessons",
    align: "right",
    className: "tabular-nums",
  },
  {
    key: "blockCount",
    header: "Blocks",
    align: "right",
    className: "tabular-nums",
  },
  {
    key: "enrollmentCount",
    header: "Learners pinned",
    align: "right",
    className: "tabular-nums",
  },
  {
    key: "changeNote",
    header: "Change note",
    className: "text-gray-600",
    render: (v) =>
      v.changeNote ?? <span className="text-gray-400">—</span>,
  },
];

const learnerColumns: ResponsiveColumn<CourseLearnerStatus>[] = [
  {
    key: "displayName",
    header: "Learner",
    primary: true,
    render: (l) => (
      <div className="flex items-center gap-2.5">
        <Avatar
          oid={l.azureOid ?? undefined}
          name={l.displayName}
          size={32}
        />
        <div className="min-w-0">
          <div className="font-medium text-gray-900 truncate">
            {l.displayName}
          </div>
          <div className="text-xs text-gray-500 truncate">{l.email}</div>
        </div>
      </div>
    ),
  },
  {
    key: "status",
    header: "State",
    render: (l) => <LearnerStatusBadge row={l} />,
  },
  {
    key: "pct",
    header: "Progress",
    render: (l) => {
      const barColor =
        l.pct >= 100
          ? "bg-green-500"
          : l.pct >= 50
            ? "bg-yellow-500"
            : "bg-red-500";
      return (
        <div className="flex items-center gap-2 min-w-[150px]">
          <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full ${barColor}`}
              style={{ width: `${l.pct}%` }}
            />
          </div>
          <span className="text-xs tabular-nums w-20 text-right text-gray-600">
            {l.doneBlocks}/{l.totalBlocks} · {l.pct}%
          </span>
        </div>
      );
    },
  },
  {
    key: "pinnedVersionNumber",
    header: "Version",
    align: "right",
    className: "tabular-nums text-gray-600",
    render: (l) =>
      l.pinnedVersionNumber != null ? `v${l.pinnedVersionNumber}` : "—",
  },
  {
    key: "enrolledAt",
    header: "Enrolled",
    align: "right",
    className: "text-gray-500 tabular-nums",
    render: (l) => fmtDay(l.enrolledAt),
  },
  {
    key: "completedAt",
    header: "Completed",
    align: "right",
    className: "text-gray-500 tabular-nums",
    render: (l) =>
      l.completedAt ? (
        fmtDay(l.completedAt)
      ) : (
        <span className="text-gray-400">—</span>
      ),
  },
];

export default async function CourseAdminDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const session = await getSessionUser();
  if (!session) {
    redirect(`/api/auth/login?returnTo=/admin/courses/${encodeURIComponent(slug)}`);
  }
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Course">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const course = await resolveCourseAdmin(tenantId, slug);
  if (!course) notFound();

  const [versions, learners, feedback, blockFeedback, appUsers, isForit] =
    await Promise.all([
      listCourseVersions(tenantId, course.courseId),
      getCourseLearnerStatus(tenantId, course.courseId),
      getCourseFeedbackSummary(tenantId, course.courseId),
      getBlockFeedbackForCourse(tenantId, course.courseId),
      listAppUsers(tenantId),
      isForitTenant(tenantId),
    ]);

  const ownerCandidates = appUsers.map((u) => ({
    appUserId: u.AppUserId,
    displayName: u.DisplayName,
    email: u.Email,
  }));

  const completed = learners.filter((l) => l.completedAt).length;

  return (
    <Shell title={course.title}>
      <div className="flex items-center gap-3 flex-wrap mb-2 -mt-2">
        <Link
          href="/admin/courses"
          prefetch={false}
          className="text-sm text-gray-500 hover:text-gray-800"
        >
          ← All courses
        </Link>
        <span
          className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${
            course.status === "published"
              ? "bg-green-100 text-green-800"
              : "bg-gray-100 text-gray-700"
          }`}
        >
          {course.status.charAt(0).toUpperCase() + course.status.slice(1)}
        </span>
        <Link
          href={`/learn/${course.slug}`}
          prefetch={false}
          className="text-sm underline text-gray-600 hover:text-gray-900"
        >
          Open in player
        </Link>
      </div>

      {/* ---- Ownership -------------------------------------------------- */}
      <SectionHeading>Ownership</SectionHeading>
      <Card variant="white" padding="lg">
        <CourseOwnerPicker
          courseId={course.courseId}
          currentOwnerUserId={course.ownerUserId}
          currentOwnerName={course.ownerName}
          currentOwnerGroupId={course.ownerGroupId}
          currentOwnerGroupName={course.ownerGroupName}
          users={ownerCandidates}
        />
        {isForit && (
          <div className="mt-5 border-t border-gray-100 pt-4">
            <CatalogPublishToggle
              courseId={course.courseId}
              initialIsCatalog={course.isCatalog}
            />
          </div>
        )}
      </Card>

      {/* ---- Version history -------------------------------------------- */}
      <SectionHeading>Version history</SectionHeading>
      <Card variant="white" padding="lg">
        <ResponsiveTable
          data={versions}
          columns={versionColumns}
          rowKey={(v) => v.versionId}
          collapseAt="md"
          emptyMessage="No published versions yet."
        />
      </Card>

      {/* ---- Learner status --------------------------------------------- */}
      <SectionHeading>
        Learner status{" "}
        <span className="text-sm font-normal text-gray-500">
          ({completed}/{learners.length} complete)
        </span>
      </SectionHeading>
      <Card variant="white" padding="lg">
        <ResponsiveTable
          data={learners}
          columns={learnerColumns}
          rowKey={(l) => l.learnerId}
          collapseAt="md"
          emptyMessage="No learners have enrolled in this course yet."
        />
      </Card>

      {/* ---- Feedback --------------------------------------------------- */}
      <SectionHeading>Feedback</SectionHeading>
      <Card variant="white" padding="lg">
        <div className="flex items-baseline gap-3 flex-wrap">
          <span className="text-sm font-semibold text-gray-700">
            Overall course rating
          </span>
          {feedback.count > 0 && feedback.avgRating != null ? (
            <>
              <Stars value={feedback.avgRating} />
              <span className="text-sm text-gray-600">
                {feedback.avgRating.toFixed(1)} / 5 · {feedback.count} rating
                {feedback.count === 1 ? "" : "s"}
              </span>
            </>
          ) : (
            <span className="text-sm text-gray-500">No ratings yet.</span>
          )}
        </div>

        {feedback.recent.length > 0 && (
          <ul className="mt-4 space-y-3">
            {feedback.recent.map((c, i) => (
              <li
                key={i}
                className="border-l-2 border-gray-200 pl-3 text-sm text-gray-700"
              >
                <div className="flex items-center gap-2">
                  <Stars value={c.rating} />
                  <span className="text-xs text-gray-500">
                    {c.learnerDisplayName} · {fmtDay(c.submittedAt)}
                  </span>
                </div>
                {c.comment && <p className="mt-1">{c.comment}</p>}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 border-t border-gray-100 pt-4">
          <p className="text-sm font-semibold text-gray-700">
            Per-slide feedback{" "}
            <span className="font-normal text-gray-500">
              ({blockFeedback.length})
            </span>
          </p>
          {blockFeedback.length === 0 ? (
            <p className="mt-2 text-sm text-gray-500">
              No slide-level notes yet. Learners leave these from the 💬 link
              while taking the course.
            </p>
          ) : (
            <ul className="mt-3 space-y-3">
              {blockFeedback.map((f) => (
                <li
                  key={f.blockFeedbackId}
                  className="rounded-md border border-gray-200 bg-gray-50 p-3 text-sm"
                >
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <span className="text-xs font-medium text-gray-600">
                      Lesson {f.lessonOrderIndex + 1}: {f.lessonTitle} · Slide{" "}
                      {f.blockOrderIndex + 1}
                    </span>
                    {f.resolved ? (
                      <span className="inline-block px-1.5 py-0.5 rounded bg-green-100 text-green-800 text-xs font-medium">
                        Resolved
                      </span>
                    ) : (
                      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-xs font-medium">
                        Open
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-gray-800">{f.comment}</p>
                  <p className="mt-1 text-xs text-gray-500">
                    {f.learnerDisplayName} · {fmtDay(f.updatedAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </Shell>
  );
}
