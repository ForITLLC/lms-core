import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import { getSessionUser } from "@/lib/get-session";
import { getThemeForRequest } from "@/lib/tenant";
import { learningLabel, tenantDisplayName } from "@/lib/tenant-label";
import { resolveLearner } from "@/lib/db/progress";
import { listCertificatesForLearner, type Certificate } from "@/lib/db/certificates";
import { listOverdueForTenant, type OverdueItem, type OverdueReason } from "@/lib/db/overdue";
import {
  listUpcomingForLearner,
  listOptionalForLearner,
  getDashboardSummary,
  type UpcomingItem,
  type OptionalItem,
} from "@/lib/db/dashboard";
import { TaskCard, type TaskUrgency } from "@/components/dashboard/TaskCard";
import { TierSection } from "@/components/dashboard/TierSection";
import { KpiStrip } from "@/components/dashboard/KpiStrip";
import { EmptyState } from "@/components/dashboard/EmptyState";
import { DrillCard } from "@/components/dashboard/DrillCard";
import { getDrillDashboard } from "@/lib/db/drill";
import { localDate } from "@/lib/drill/local-date";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

const OVERDUE_REASON_LABEL: Record<OverdueReason, string> = {
  expired_cert: "Certificate expired",
  never_completed: "Not yet completed",
  recurring_lapsed: "Recurring training due",
};

function fmtDate(d: Date | string): string {
  return new Date(d).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function daysSince(d: Date): number {
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

function overdueUrgency(item: OverdueItem): TaskUrgency {
  if (!item.dueDate) return "overdue";
  const ms = Date.now() - item.dueDate.getTime();
  // > 7 days late = full red; otherwise still red but at least it just slipped.
  return ms > 7 * 86_400_000 ? "overdue" : "overdue";
}

function overdueStatus(item: OverdueItem): string {
  if (!item.dueDate) return "Overdue";
  const days = daysSince(item.dueDate);
  if (days === 0) return "Due today";
  return `Overdue ${days}d`;
}

function upcomingUrgency(item: UpcomingItem): TaskUrgency {
  return item.daysUntilDue <= 7 ? "due-soon" : "upcoming";
}

function upcomingStatus(item: UpcomingItem): string {
  if (item.daysUntilDue === 0) return "Due today";
  if (item.daysUntilDue === 1) return "Due tomorrow";
  return `Due in ${item.daysUntilDue}d`;
}

export default async function DashboardPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/dashboard");

  const theme = await getThemeForRequest();
  const label = learningLabel(tenantDisplayName(theme));
  const firstName = (session.name ?? session.email ?? "there").split(/\s+/)[0];
  const isStaff = session.role === "admin" || session.role === "author";

  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title={`Welcome, ${firstName}`}>
        <p className="text-gray-700">
          Your session isn&rsquo;t bound to a tenant yet. Sign out and back in,
          or contact your administrator.
        </p>
      </Shell>
    );
  }

  const learner = await resolveLearner(
    tenantId,
    session.email,
    session.name ?? session.email,
    session.azureOid,
  );

  const [allOverdue, upcoming, optional, summary, certificates, drill] =
    await Promise.all([
      listOverdueForTenant(tenantId),
      listUpcomingForLearner(tenantId, learner.learnerId),
      listOptionalForLearner(tenantId, learner.learnerId),
      getDashboardSummary(tenantId, learner.learnerId),
      listCertificatesForLearner(learner.learnerId),
      getDrillDashboard(tenantId, learner.learnerId),
    ]);
  const drillCompletedToday =
    drill?.latest != null &&
    drill.latest.completed &&
    drill.latest.localDate === localDate(new Date(), drill.latest.timeZone);

  const required = allOverdue
    .filter((it) => it.learnerId === learner.learnerId)
    .sort((a, b) => {
      const ad = a.dueDate?.getTime() ?? 0;
      const bd = b.dueDate?.getTime() ?? 0;
      return ad - bd;
    });

  const isFullyEmpty =
    required.length === 0 &&
    upcoming.length === 0 &&
    optional.length === 0;

  return (
    <Shell title={`Hi ${firstName}`}>
      {drill ? (
        <DrillCard stats={drill.stats} completedToday={drillCompletedToday} latest={drill.latest} />
      ) : null}

      <p className="text-gray-700 mb-6">
        {required.length > 0 ? (
          <>
            You have{" "}
            <span className="font-semibold text-gray-900">
              {required.length} required item{required.length === 1 ? "" : "s"}
            </span>{" "}
            to action on <span className="font-semibold">{label}</span>.
          </>
        ) : upcoming.length > 0 ? (
          <>
            You&rsquo;re all caught up on{" "}
            <span className="font-semibold">{label}</span> 🎉
            Here&rsquo;s what&rsquo;s coming up.
          </>
        ) : (
          <>
            You&rsquo;re all caught up on{" "}
            <span className="font-semibold">{label}</span> 🎉
          </>
        )}
      </p>

      <KpiStrip
        requiredCount={summary.requiredCount}
        upcomingCount={summary.upcomingCount}
        certificatesValid={summary.certificatesValid}
      />

      {isFullyEmpty ? (
        <EmptyState
          icon={<span aria-hidden="true" className="text-3xl">📚</span>}
          title="No courses published yet"
          message="Your tenant hasn't added any courses yet. Once your admin publishes the first course it'll show up here."
        />
      ) : null}

      <TierSection
        id="required"
        title="Required"
        subtitle={
          required.length > 0
            ? "Action these now — overdue or already due"
            : undefined
        }
        count={required.length}
        emptyState={
          upcoming.length === 0 && optional.length > 0 ? (
            <EmptyState
              icon={<span aria-hidden="true" className="text-3xl">🎉</span>}
              title="You're all caught up"
              message="Nothing required, nothing due soon. Browse the library when you have time — every course is a 15–30 minute investment."
            />
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 gap-3">
          {required.map((it) => (
            <TaskCard
              key={it.courseId}
              href={`/learn/${it.courseSlug}`}
              title={it.courseTitle}
              reason={OVERDUE_REASON_LABEL[it.overdueReason]}
              meta={it.dueDate ? `Was due ${fmtDate(it.dueDate)}` : undefined}
              urgency={overdueUrgency(it)}
              statusText={overdueStatus(it)}
              action="Start now"
            />
          ))}
        </div>
      </TierSection>

      <TierSection
        id="upcoming"
        title="Upcoming"
        subtitle="Due in the next 60 days"
        count={upcoming.length}
      >
        <div className="grid grid-cols-1 gap-3">
          {upcoming.map((it) => (
            <TaskCard
              key={it.courseId}
              href={`/learn/${it.courseSlug}`}
              title={it.courseTitle}
              reason={
                it.upcomingReason === "cert_renewing"
                  ? "Certificate renewing"
                  : it.upcomingReason === "recurring_due"
                    ? "Recurring training"
                    : "First-time required"
              }
              meta={`Due ${fmtDate(it.dueDate)}`}
              urgency={upcomingUrgency(it)}
              statusText={upcomingStatus(it)}
              action="Get ahead"
            />
          ))}
        </div>
      </TierSection>

      <TierSection
        id="optional"
        title="Optional"
        subtitle="Build skills at your own pace"
        count={optional.length}
      >
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {optional.map((it: OptionalItem) => (
            <TaskCard
              key={it.courseId}
              href={`/learn/${it.courseSlug}`}
              title={it.courseTitle}
              reason={it.description ?? it.category ?? "Optional course"}
              urgency="optional"
              statusText={
                it.completed
                  ? "Completed"
                  : it.progressPct > 0
                    ? "In progress"
                    : "Available"
              }
              progressPct={it.progressPct}
              action={
                it.completed
                  ? "Review"
                  : it.progressPct > 0
                    ? "Continue"
                    : "Start"
              }
            />
          ))}
        </div>
      </TierSection>

      {certificates.length > 0 ? (
        <details className="mt-10 group">
          <summary className="cursor-pointer text-sm font-semibold text-gray-700 hover:text-gray-900">
            Your certificates ({certificates.length})
          </summary>
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {certificates.map((cert: Certificate) => (
              <Card key={cert.CertificateId} variant="white" padding="md">
                <p className="text-xs uppercase tracking-wide text-gray-400">
                  Certificate · {cert.SerialNo}
                </p>
                <h3
                  className="font-semibold mt-1"
                  style={{ color: "var(--brand-primary)" }}
                >
                  {cert.CourseTitle}
                </h3>
                <p className="text-xs text-gray-500 mt-1">
                  Issued {fmtDate(cert.IssuedAt)}
                  {cert.ExpiresAt ? ` · expires ${fmtDate(cert.ExpiresAt)}` : ""}
                </p>
                <Link
                  href={`/certificate/${cert.SerialNo}`}
                  prefetch={false}
                  target="_blank"
                  className="mt-3 inline-block text-sm font-semibold hover:underline"
                  style={{ color: "var(--brand-primary)" }}
                >
                  View &amp; download ↗
                </Link>
              </Card>
            ))}
          </div>
        </details>
      ) : null}

      {isStaff ? (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm font-semibold text-gray-700 hover:text-gray-900">
            Staff tools
          </summary>
          <div className="mt-3 flex flex-wrap gap-4 text-sm">
            <Link
              href="/author"
              className="font-semibold hover:underline"
              style={{ color: "var(--brand-primary)" }}
            >
              Authoring tools →
            </Link>
            <Link
              href="/admin/curriculum"
              className="font-semibold hover:underline"
              style={{ color: "var(--brand-primary)" }}
            >
              Curriculum management →
            </Link>
            <Link
              href="/admin"
              className="font-semibold hover:underline"
              style={{ color: "var(--brand-primary)" }}
            >
              Admin →
            </Link>
          </div>
        </details>
      ) : null}

      <div className="mt-10 text-xs text-gray-500">
        Signed in as <span className="font-mono">{session.email}</span>
      </div>
    </Shell>
  );
}
