import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleSession, type DuePool, type NewPool, type ReasoningPool } from "./assemble";

const due = (n: number, course = "c1"): DuePool[] =>
  Array.from({ length: n }, (_, i) => ({
    cardId: `card-${course}-${i}`,
    questionId: `q-${course}-${i}`,
    courseId: course,
    courseTitle: `Course ${course}`,
    courseSlug: course,
    due: new Date(Date.UTC(2026, 8, 1, i)),
  }));
const fresh = (n: number, course: string): NewPool[] =>
  Array.from({ length: n }, (_, i) => ({
    questionId: `nq-${course}-${i}`,
    courseId: course,
    courseTitle: `Course ${course}`,
    courseSlug: course,
  }));
const reasoning = (n: number): ReasoningPool[] =>
  Array.from({ length: n }, (_, i) => ({ drillItemId: `r-${i}`, category: "logic" }));

test("empty pools give an empty session", () => {
  assert.deepEqual(assembleSession({ dueCards: [], newQuestions: [], reasoningItems: [] }), []);
});

test("due cards come first in due order, then one reasoning item, five total", () => {
  const items = assembleSession({
    dueCards: [...due(6)].reverse(),
    newQuestions: fresh(3, "c2"),
    reasoningItems: reasoning(3),
  });
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((i) => i.slot), [0, 1, 2, 3, 4]);
  assert.deepEqual(items.slice(0, 4).map((i) => i.cardId), ["card-c1-0", "card-c1-1", "card-c1-2", "card-c1-3"]);
  assert.equal(items[4]?.source, "reasoning");
});

test("new questions interleave across courses after due cards", () => {
  const items = assembleSession({
    dueCards: due(1),
    newQuestions: [...fresh(3, "c2"), ...fresh(3, "c3")],
    reasoningItems: reasoning(1),
  });
  assert.deepEqual(items.map((i) => i.source), ["retrieval", "retrieval", "retrieval", "retrieval", "reasoning"]);
  assert.deepEqual(items.slice(1, 4).map((i) => i.courseId), ["c2", "c3", "c2"]);
  assert.equal(items[1]?.cardId, undefined);
});

test("short retrieval supply is filled with reasoning items", () => {
  const items = assembleSession({ dueCards: [], newQuestions: fresh(1, "c1"), reasoningItems: reasoning(10) });
  assert.equal(items.length, 5);
  assert.equal(items.filter((i) => i.source === "reasoning").length, 4);
  assert.equal(new Set(items.map((i) => i.drillItemId ?? i.questionId)).size, 5);
});

test("no reasoning bank means a retrieval-only session", () => {
  const items = assembleSession({ dueCards: due(2), newQuestions: fresh(1, "c2"), reasoningItems: [] });
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.source === "retrieval"));
});
