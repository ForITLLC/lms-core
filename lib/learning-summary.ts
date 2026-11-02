export interface SummaryItem {
  id: string;
  course_id: string;
  course_slug: string;
  course_title: string;
  learner_id: string;
  learner_name: string;
  learner_email: string;
  due_date: string | null;
  occurred_at: string | null;
}

export const SUMMARY_CATEGORIES = ["overdue", "due", "completions", "new_assignments"] as const;
export type SummaryCategory = typeof SUMMARY_CATEGORIES[number];
export type SummarySection = Record<SummaryCategory, SummaryItem[]>;
export interface LearningSummary {
  generated_at: string;
  window_start: string;
  personal: SummarySection;
  team: (SummarySection & { scope: "manager" | "admin" }) | null;
}

export function emptySummarySection(): SummarySection {
  return { due: [], overdue: [], completions: [], new_assignments: [] };
}

const identity = (item: SummaryItem) => `${item.learner_id}:${item.course_id}`.toLowerCase();

export function normalizeSummarySection(section: SummarySection): SummarySection {
  const out = emptySummarySection();
  for (const category of SUMMARY_CATEGORIES) {
    const unique = new Map<string, SummaryItem>();
    for (const item of section[category]) {
      const previous = unique.get(identity(item));
      if (!previous || (item.occurred_at ?? "") > (previous.occurred_at ?? "")) unique.set(identity(item), item);
    }
    out[category] = [...unique.values()].sort((a, b) =>
      (a.due_date ?? a.occurred_at ?? "").localeCompare(b.due_date ?? b.occurred_at ?? "") ||
      a.learner_name.localeCompare(b.learner_name) || a.course_title.localeCompare(b.course_title) || a.id.localeCompare(b.id));
  }
  const overdue = new Set(out.overdue.map(identity));
  out.due = out.due.filter(item => !overdue.has(identity(item)));
  return out;
}

export function summaryItemCount(summary: LearningSummary): number {
  return SUMMARY_CATEGORIES.reduce((count, category) => count + summary.personal[category].length + (summary.team?.[category].length ?? 0), 0);
}

export function summaryWindow(now: Date, requestedStart?: Date): { now: Date; start: Date } {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid summary time");
  const fallback = new Date(now.getTime() - 86_400_000);
  return { now, start: requestedStart && Number.isFinite(requestedStart.getTime()) && requestedStart <= now ? requestedStart : fallback };
}
