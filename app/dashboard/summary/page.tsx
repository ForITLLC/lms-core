import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import SummaryManagers from "@/components/SummaryManagers";
import { getSessionUser } from "@/lib/get-session";
import { getLearningSummary, getSummaryIdentity } from "@/lib/db/learning-summary";
import { SUMMARY_CATEGORIES, type SummaryCategory, type SummarySection } from "@/lib/learning-summary";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;
export const dynamic = "force-dynamic";

const labels: Record<SummaryCategory, string> = {
  overdue: "Overdue training",
  due: "Due in the next 14 days",
  completions: "Completed",
  new_assignments: "New assignments",
};

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(value));
}

function SummaryGroup({ title, section, team = false }: { title: string; section: SummarySection; team?: boolean }) {
  return (
    <section aria-label={title} className="mb-8">
      <h2 className="text-xl font-semibold text-gray-900 mb-4">{title}</h2>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {SUMMARY_CATEGORIES.map(category => (
          <Card key={category} variant="white" padding="lg">
            <h3 className="text-lg font-semibold text-gray-900">{labels[category]} ({section[category].length})</h3>
            {section[category].length === 0 ? <p className="mt-3 text-gray-600">No items in this summary.</p> : (
              <ul className="divide-y divide-gray-200 mt-3">
                {section[category].map(item => (
                  <li key={item.id} className="py-3">
                    <Link href={`/learn/${encodeURIComponent(item.course_slug)}`} className="font-semibold underline" style={{ color: "var(--brand-primary)" }}>
                      {item.course_title}
                    </Link>
                    {team ? <p className="text-sm text-gray-700">{item.learner_name} · {item.learner_email}</p> : null}
                    {item.due_date ? <p className="text-sm text-gray-600">Due {dateLabel(item.due_date)}</p> : null}
                    {item.occurred_at ? <p className="text-sm text-gray-600">{category === "completions" ? "Completed" : "Assigned"} {dateLabel(item.occurred_at)}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        ))}
      </div>
    </section>
  );
}

export default async function LearningSummaryPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/dashboard/summary");
  if (!session.tenantId) return <Shell title="Learning summary"><p>Your sign-in needs an organisation. Sign out and back in, or contact your administrator.</p></Shell>;
  const [summary, identity] = await Promise.all([
    getLearningSummary(session.tenantId, session.email),
    getSummaryIdentity(session.tenantId, session.email),
  ]);
  return (
    <Shell title="Learning summary">
      <p className="text-gray-600 mb-6">Training due soon and overdue, with completions and new assignments since {dateLabel(summary.window_start)}. Daily notifications combine these items into one digest.</p>
      <SummaryGroup title="Your learning" section={summary.personal} />
      {summary.team ? <SummaryGroup title={summary.team.scope === "admin" ? "Your organisation" : "Your team"} section={summary.team} team /> : null}
      {identity?.Role === "admin" ? <SummaryManagers /> : null}
    </Shell>
  );
}
