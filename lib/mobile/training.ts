import type { OverdueItem } from "@/lib/db/overdue";
import type { OptionalItem, UpcomingItem } from "@/lib/db/dashboard";
import type { CourseAssignmentRow } from "@/lib/db/assignments";
import type { CourseProgress } from "@/lib/db/progress";

// "My training" for the iPhone app: the web dashboard's Required / Upcoming
// tiers (lib/db/overdue.ts, lib/db/dashboard.ts) plus the learner's active
// manual assignments (lms.CourseAssignment), merged to one row per course,
// overdue first, then by due date. Pure, so the ordering is unit-tested.

export type TrainingStatus = "overdue" | "due" | "assigned";

export interface TrainingItem {
  course_id: string;
  slug: string;
  title: string;
  status: TrainingStatus;
  reason: string;
  due_date: string | null;
  days_until_due: number | null;
  progress_pct: number;
  completed: boolean;
  note: string | null;
}

export interface OptionalTrainingItem {
  course_id: string;
  slug: string;
  title: string;
  description: string | null;
  category: string | null;
  progress_pct: number;
  completed: boolean;
}

export interface TrainingInput {
  overdue: OverdueItem[];
  upcoming: UpcomingItem[];
  assignments: CourseAssignmentRow[];
  optional: OptionalItem[];
  progress: Map<string, CourseProgress>;
  now: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RANK: Record<TrainingStatus, number> = { overdue: 0, due: 1, assigned: 2 };

const key = (courseId: string) => courseId.toUpperCase();

function progressFor(progress: Map<string, CourseProgress>, courseId: string): CourseProgress | undefined {
  return progress.get(courseId) ?? progress.get(key(courseId)) ?? progress.get(courseId.toLowerCase());
}

function daysUntil(due: Date, now: Date): number {
  return Math.ceil((due.getTime() - now.getTime()) / DAY_MS);
}

export function buildTraining(input: TrainingInput): {
  assigned: TrainingItem[];
  optional: OptionalTrainingItem[];
} {
  const { now } = input;
  const byCourse = new Map<string, TrainingItem>();

  const put = (item: TrainingItem) => {
    const existing = byCourse.get(key(item.course_id));
    if (!existing || RANK[item.status] < RANK[existing.status]) {
      byCourse.set(key(item.course_id), { ...item, note: item.note ?? existing?.note ?? null });
    } else if (!existing.note && item.note) {
      existing.note = item.note;
    }
  };

  const base = (courseId: string) => {
    const p = progressFor(input.progress, courseId);
    return { progress_pct: p?.pct ?? 0, completed: p?.completed ?? false };
  };

  for (const o of input.overdue) {
    put({
      course_id: o.courseId,
      slug: o.courseSlug,
      title: o.courseTitle,
      status: "overdue",
      reason: o.overdueReason,
      due_date: o.dueDate ? new Date(o.dueDate).toISOString() : null,
      days_until_due: o.dueDate ? daysUntil(new Date(o.dueDate), now) : null,
      ...base(o.courseId),
      // An overdue course is never shown as done, even when an old pass rolled
      // its blocks up to 100%: the lapse is what's being reported.
      completed: false,
      note: null,
    });
  }

  for (const u of input.upcoming) {
    const due = new Date(u.dueDate);
    put({
      course_id: u.courseId,
      slug: u.courseSlug,
      title: u.courseTitle,
      status: "due",
      reason: u.upcomingReason,
      due_date: due.toISOString(),
      days_until_due: daysUntil(due, now),
      ...base(u.courseId),
      note: null,
    });
  }

  for (const a of input.assignments) {
    if (a.Status !== "active") continue;
    const progress = base(a.CourseId);
    if (progress.completed) continue;
    const due = a.DueDate ? new Date(a.DueDate) : null;
    const lapsed = due !== null && due.getTime() < now.getTime();
    put({
      course_id: a.CourseId,
      slug: a.CourseSlug,
      title: a.CourseTitle,
      status: lapsed ? "overdue" : due ? "due" : "assigned",
      reason: "assigned",
      due_date: due ? due.toISOString() : null,
      days_until_due: due ? daysUntil(due, now) : null,
      ...progress,
      note: a.Note,
    });
  }

  const assigned = [...byCourse.values()].sort((a, b) => {
    if (RANK[a.status] !== RANK[b.status]) return RANK[a.status] - RANK[b.status];
    if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
    if (a.due_date) return -1;
    if (b.due_date) return 1;
    return a.title.localeCompare(b.title);
  });

  const optional = input.optional
    .filter((o) => !byCourse.has(key(o.courseId)))
    .map((o) => ({
      course_id: o.courseId,
      slug: o.courseSlug,
      title: o.courseTitle,
      description: o.description,
      category: o.category,
      progress_pct: o.progressPct,
      completed: o.completed,
    }));

  return { assigned, optional };
}
