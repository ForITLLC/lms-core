import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import GradingQueue, { type QueueItem } from "@/components/author/GradingQueue";
import { MARK_REASON_MAX_CHARS } from "@/lib/ai/grading/written-answer";

// The staff marking queue (slice A5b): the learner's answer and the AI's
// feedback are shown as text, Confirm is offered only where there is an AI
// mark to confirm, and the reason box stops where the grades route does.

(globalThis as { React?: typeof React }).React = React;

const ITEM: QueueItem = {
  attemptId: "e0e0e0e0-0000-4000-8000-000000000001",
  questionId: "dddddddd-0000-0000-0000-0000000000a1",
  learnerName: "Pilot A",
  waitingSince: "2026-10-29T01:00:00.000Z",
  courseTitle: "Principles of Flight",
  lessonTitle: "Lift",
  questionNumber: 2,
  promptMd: "Why does a wing produce lift?",
  rubricMd: "Names the pressure difference",
  maxScore: 5,
  answer: "Lift comes from <script>alert(1)</script>",
  aiGradeId: "abababab-0000-4000-8000-000000000001",
  aiScore: 3,
  aiMaxScore: 5,
  aiFeedbackMd: "Name <b>why</b> the pressure differs.",
  instructorScore: null,
  review: null,
};
const render = (items: QueueItem[], total = items.length) => renderToStaticMarkup(React.createElement(GradingQueue, { items, total }));

test("the learner's answer, the AI's feedback and the learner's note are shown as text, never as markup", () => {
  const html = render([{ ...ITEM, review: { note: "I said <i>why</i>.", requestedAt: "2026-10-29T02:00:00.000Z" }, instructorScore: 2 }]);
  assert.ok(html.includes("Lift comes from &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("Name &lt;b&gt;why&lt;/b&gt; the pressure differs."));
  assert.ok(html.includes("I said &lt;i&gt;why&lt;/i&gt;."));
  for (const tag of ["<script>", "<b>why", "<i>why"]) assert.equal(html.includes(tag), false, tag);
  assert.ok(html.includes("the current mark is 2/5"));
});

test("Confirm is offered only for an answer with an AI mark; without one the instructor marks it", () => {
  const withAi = render([ITEM]);
  assert.ok(withAi.includes("Confirm AI mark"), "known positive");
  assert.ok(withAi.includes("AI mark (provisional): 3/5"));
  assert.ok(withAi.includes("Override with this mark"));

  const without = render([{ ...ITEM, aiGradeId: null, aiScore: null, aiMaxScore: null, aiFeedbackMd: null }]);
  assert.equal(without.includes("Confirm AI mark"), false);
  assert.equal(without.includes("AI mark (provisional)"), false);
  assert.ok(without.includes("No AI mark. Mark this answer yourself."));
  assert.ok(without.includes("Save mark"));
});

test("the reason box stops at the length the grades route accepts, and the count says when more are waiting than shown", () => {
  const html = render([ITEM], 7);
  assert.ok(html.includes(`maxLength="${MARK_REASON_MAX_CHARS}"`));
  assert.ok(html.includes("7 written answers are waiting for an instructor; the 1 waiting longest are shown."));
  assert.ok(render([], 0).includes("No written answers are waiting for you."));
});
