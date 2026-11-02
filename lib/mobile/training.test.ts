import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTraining, type TrainingInput } from "./training";

const NOW = new Date("2026-10-10T12:00:00Z");

const input = (over: Partial<TrainingInput> = {}): TrainingInput => ({
  overdue: [],
  upcoming: [],
  assignments: [],
  optional: [],
  progress: new Map(),
  now: NOW,
  ...over,
});

const assignment = (courseId: string, due: string | null, over: Record<string, unknown> = {}) =>
  ({
    AssignmentId: `A-${courseId}`,
    LearnerId: "L1",
    LearnerEmail: "a@x.test",
    LearnerName: "A",
    CourseId: courseId,
    CourseSlug: courseId.toLowerCase(),
    CourseTitle: `Course ${courseId}`,
    VersionId: "V1",
    VersionNumber: 1,
    AssignedBy: "admin@x.test",
    AssignedAt: new Date("2026-09-01T00:00:00Z"),
    DueDate: due ? new Date(due) : null,
    Note: null,
    Status: "active",
    ...over,
  }) as TrainingInput["assignments"][number];

test("overdue first, then by due date, undated assignments last", () => {
  const { assigned } = buildTraining(
    input({
      upcoming: [
        { courseId: "C2", courseTitle: "Late", courseSlug: "c2", dueDate: new Date("2026-12-01T00:00:00Z"), daysUntilDue: 52, upcomingReason: "first_due" },
        { courseId: "C3", courseTitle: "Soon", courseSlug: "c3", dueDate: new Date("2026-10-20T00:00:00Z"), daysUntilDue: 10, upcomingReason: "recurring_due" },
      ],
      overdue: [
        { learnerId: "L1", email: "a@x.test", displayName: "A", courseId: "C1", courseTitle: "Lapsed", courseSlug: "c1", overdueReason: "expired_cert", dueDate: new Date("2026-09-01T00:00:00Z") },
      ],
      assignments: [assignment("C4", null)],
    }),
  );
  assert.deepEqual(assigned.map((a) => a.course_id), ["C1", "C3", "C2", "C4"]);
  assert.deepEqual(assigned.map((a) => a.status), ["overdue", "due", "due", "assigned"]);
  assert.equal(assigned[0]?.days_until_due, -39);
  assert.equal(assigned[1]?.days_until_due, 10);
});

test("a course in several sources appears once, at its most urgent status", () => {
  const { assigned } = buildTraining(
    input({
      overdue: [
        { learnerId: "L1", email: "a@x.test", displayName: "A", courseId: "c1", courseTitle: "Lapsed", courseSlug: "c1", overdueReason: "never_completed", dueDate: null },
      ],
      assignments: [assignment("C1", "2026-11-01T00:00:00Z", { Note: "Before the audit" })],
    }),
  );
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0]?.status, "overdue");
  assert.equal(assigned[0]?.note, "Before the audit");
});

test("a lapsed assignment is overdue; a finished or cancelled one is dropped", () => {
  const progress = new Map([["C6", { totalBlocks: 4, completedBlocks: 4, pct: 100, completed: true }]]);
  const { assigned } = buildTraining(
    input({
      progress,
      assignments: [
        assignment("C5", "2026-10-01T00:00:00Z"),
        assignment("C6", "2026-11-01T00:00:00Z"),
        assignment("C7", "2026-11-01T00:00:00Z", { Status: "cancelled" }),
      ],
    }),
  );
  assert.deepEqual(assigned.map((a) => [a.course_id, a.status]), [["C5", "overdue"]]);
});

test("progress is joined case-insensitively and optional excludes assigned courses", () => {
  const progress = new Map([["c3", { totalBlocks: 4, completedBlocks: 1, pct: 25, completed: false }]]);
  const { assigned, optional } = buildTraining(
    input({
      progress,
      upcoming: [
        { courseId: "C3", courseTitle: "Soon", courseSlug: "c3", dueDate: new Date("2026-10-20T00:00:00Z"), daysUntilDue: 10, upcomingReason: "first_due" },
      ],
      optional: [
        { courseId: "C3", courseTitle: "Soon", courseSlug: "c3", description: null, category: null, progressPct: 25, completed: false },
        { courseId: "C9", courseTitle: "Extra", courseSlug: "c9", description: "d", category: "Safety", progressPct: 0, completed: false },
      ],
    }),
  );
  assert.equal(assigned[0]?.progress_pct, 25);
  assert.deepEqual(optional.map((o) => o.course_id), ["C9"]);
});

test("an optional course with all blocks viewed stays incomplete until enrollment completes", () => {
  const { optional } = buildTraining(input({
    optional: [
      { courseId: "C9", courseTitle: "Quiz still owed", courseSlug: "c9", description: null,
        category: null, progressPct: 100, completed: false },
      { courseId: "C10", courseTitle: "Finished", courseSlug: "c10", description: null,
        category: null, progressPct: 100, completed: true },
    ],
  }));
  assert.deepEqual(optional.map((course) => [course.course_id, course.progress_pct, course.completed]),
    [["C9", 100, false], ["C10", 100, true]]);
});
