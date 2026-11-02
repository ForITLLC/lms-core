import { test } from "node:test";
import assert from "node:assert/strict";
import { emptySummarySection, normalizeSummarySection, summaryItemCount, summaryWindow, type SummaryItem } from "./learning-summary";

const row: SummaryItem = { id: "a", course_id: "C", course_slug: "course", course_title: "Training", learner_id: "L", learner_name: "Learner", learner_email: "learner@example.test", due_date: null, occurred_at: null };

test("summary groups duplicate course identities, retains distinct learners and prioritizes overdue", () => {
  const section = emptySummarySection();
  section.due = [row, { ...row, id: "b", course_id: "c", learner_id: "l" }, { ...row, learner_id: "other" }];
  section.overdue = [row];
  section.completions = [{ ...row, occurred_at: "2026-10-17T10:00:00Z" }, { ...row, occurred_at: "2026-10-17T11:00:00Z" }];
  const result = normalizeSummarySection(section);
  assert.equal(result.due.length, 1);
  assert.equal(result.due[0]!.learner_id, "other");
  assert.equal(result.overdue.length, 1);
  assert.equal(result.completions.length, 1);
  assert.equal(result.completions[0]!.occurred_at, "2026-10-17T11:00:00Z");
  assert.equal(summaryItemCount({ generated_at: "", window_start: "", personal: result, team: null }), 3);
});

test("window uses last successful cutoff and rejects future or invalid watermarks", () => {
  const now = new Date("2026-10-18T12:00:00Z");
  const previous = new Date("2026-10-16T12:00:00Z");
  assert.equal(summaryWindow(now, previous).start, previous);
  assert.equal(summaryWindow(now).start.toISOString(), "2026-10-17T12:00:00.000Z");
  assert.equal(summaryWindow(now, new Date("2030-01-01")).start.toISOString(), "2026-10-17T12:00:00.000Z");
  assert.equal(summaryWindow(now, new Date(NaN)).start.toISOString(), "2026-10-17T12:00:00.000Z");
  assert.throws(() => summaryWindow(new Date(NaN)), /Invalid/);
});
