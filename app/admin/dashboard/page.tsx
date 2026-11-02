import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/ui/ResponsiveTable";
import ShellRaw from "@/components/Shell";
import Button from "@/components/Button";
import { getSessionUser } from "@/lib/get-session";
import { getDefaultCurriculum } from "@/lib/db/curriculum";
import {
  getMandatoryCompletionSummary,
  getComplianceTotals,
  type CourseComplianceRow,
} from "@/lib/db/reporting";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

function pct(num: number, denom: number): number {
  return denom > 0 ? Math.round((num / denom) * 100) : 0;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <Card variant="white" padding="md">
      <div className="text-xs uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-2xl font-semibold mt-1" style={{ color: "var(--brand-primary)" }}>
        {value}
      </div>
      {sub && <div className="text-xs text-gray-500 mt-1">{sub}</div>}
    </Card>
  );
}

const columns: ResponsiveColumn<CourseComplianceRow>[] = [
  {
    key: "title",
    header: "Course",
    primary: true,
    render: (row) => (
      <>
        {row.isCatalogue ? (
          <span className="font-medium">{row.title}</span>
        ) : (
          <Link
            href={`/admin/courses/${row.slug}`}
            prefetch={false}
            className="font-medium hover:underline"
            style={{ color: "var(--brand-primary)" }}
          >
            {row.title}
          </Link>
        )}
        <div className="text-xs text-gray-500 mt-0.5">
          {row.isMandatory ? (
            <span className="inline-block px-1.5 py-0.5 rounded bg-red-100 text-red-800 font-medium">
              Mandatory
            </span>
          ) : (
            <span className="inline-block px-1.5 py-0.5 rounded bg-gray-100 text-gray-700">
              Optional
            </span>
          )}
          {row.category && <span className="ml-2">{row.category}</span>}
          {row.isCatalogue && <span className="ml-2">Catalogue</span>}
        </div>
      </>
    ),
  },
  { key: "totalEnrolled", header: "Enrolled", align: "right", className: "tabular-nums" },
  { key: "completed", header: "Done", align: "right", className: "tabular-nums" },
  { key: "pending", header: "Pending", align: "right", className: "tabular-nums text-gray-600" },
  {
    key: "completion",
    header: "Completion",
    render: (row) => {
      const completionPct = pct(row.completed, row.totalEnrolled);
      const barColor =
        completionPct >= 90
          ? "bg-green-500"
          : completionPct >= 60
            ? "bg-yellow-500"
            : "bg-red-500";
      return (
        <div className="flex items-center gap-2 min-w-[140px]">
          <div className="flex-1 h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className={`h-full ${barColor}`}
              style={{ width: `${completionPct}%` }}
            />
          </div>
          <span className="text-xs tabular-nums w-9 text-right">{completionPct}%</span>
        </div>
      );
    },
  },
  { key: "certIssued", header: "Cert valid", align: "right", className: "tabular-nums" },
  {
    key: "certExpired",
    header: "Cert expired",
    align: "right",
    className: "tabular-nums",
    render: (row) =>
      row.certExpired > 0 ? (
        <span className="text-red-700 font-semibold">{row.certExpired}</span>
      ) : (
        <span className="text-gray-400">0</span>
      ),
  },
];

export default async function ComplianceDashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/dashboard");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Compliance dashboard">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const curriculum = await getDefaultCurriculum(tenantId);
  const curriculumId = curriculum?.curriculumId;

  const [totals, rows] = await Promise.all([
    getComplianceTotals(tenantId, curriculumId),
    getMandatoryCompletionSummary(tenantId, curriculumId),
  ]);

  const mandatoryPct = pct(totals.mandatoryCompletions, totals.totalMandatoryEnrollments);

  return (
    <Shell title="Compliance dashboard">
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <p className="text-gray-700 max-w-prose">
          {curriculum ? (
            <>
              Measured against curriculum{" "}
              <span className="font-semibold">{curriculum.name}</span>.
            </>
          ) : (
            <>No default curriculum is configured — showing all tenant courses.</>
          )}
        </p>
        <Button
          href={`/api/admin/compliance.csv${curriculumId ? `?curriculum=${curriculumId}` : ""}`}
          variant="secondary"
          size="sm"
        >
          Export CSV
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        <StatCard label="Learners" value={totals.totalLearners} />
        <StatCard
          label="Mandatory courses"
          value={totals.totalMandatoryCourses}
        />
        <StatCard
          label="Mandatory enrollments"
          value={totals.totalMandatoryEnrollments}
        />
        <StatCard
          label="Mandatory complete"
          value={totals.mandatoryCompletions}
          sub={`${mandatoryPct}% of enrollments`}
        />
        <StatCard label="Certificates valid" value={totals.certificatesValid} />
        <StatCard
          label="Certificates expired"
          value={totals.certificatesExpired}
          sub={totals.certificatesExpired > 0 ? "Renewal required" : undefined}
        />
      </div>

      <Card variant="white" padding="lg">
        <ResponsiveTable
          data={rows}
          columns={columns}
          rowKey={(r) => r.courseId}
          emptyMessage="No courses in scope yet. Add courses to the default curriculum to see completion data here."
        />
      </Card>
    </Shell>
  );
}
