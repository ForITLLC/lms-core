import { test } from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import CoursePlayer from "@/components/CoursePlayer";
import WrittenAnswerMark from "@/components/WrittenAnswerMark";
import { AI_MARKING_NOTICE, ANSWER_MAX_CHARS, type WrittenAnswerMark as Mark } from "@/lib/ai/grading/written-answer";
import { buildPreview } from "@/lib/builder/preview";
import { DraftDoc } from "@/lib/schema/draft";

// The course player's written-answer box and a written answer's mark (slice
// A5b): the AI notice only where the tenant has AI marking on, the box stops
// where the grader does, and the marker's feedback is shown as text.

(globalThis as { React?: typeof React }).React = React;

const doc = DraftDoc.parse({
  meta: { title: "Principles of flight", requiresQuizPass: true },
  lessons: [
    {
      key: "l1",
      title: "Lift",
      blocks: [
        { kind: "text", key: "t1", markdown: "Read this first" },
        { kind: "quiz", key: "q1", passingScore: 70, questions: [{ kind: "short", promptMd: "Why does a wing lift?", rubricMd: "Pressure difference", maxScore: 5 }] },
      ],
    },
  ],
});
const preview = buildPreview({ courseId: "dddddddd-0000-0000-0000-00000000000c", slug: "flight" }, doc);
const seen = preview.lessons.flatMap((l) => l.blocks.filter((b) => b.kind === "text").map((b) => b.blockId));

const writtenSlide = (aiMarking?: boolean) =>
  renderToStaticMarkup(
    React.createElement(CoursePlayer, { course: preview.course, lessons: preview.lessons, completedBlockIds: seen, ...(aiMarking === undefined ? {} : { aiMarking }) }),
  );

test("the AI notice shows on a written question only where the tenant has AI marking on", () => {
  const on = writtenSlide(true);
  assert.ok(on.includes("Why does a wing lift?"), "known positive: the written question is the slide shown");
  assert.ok(on.includes(AI_MARKING_NOTICE));
  for (const html of [writtenSlide(false), writtenSlide()]) {
    assert.ok(html.includes("Why does a wing lift?"));
    assert.equal(html.includes(AI_MARKING_NOTICE), false);
    assert.ok(html.includes("Your instructor marks written answers."));
  }
});

test("the answer box stops at the length the grader accepts", () => {
  const html = writtenSlide(true);
  const box = html.match(/<textarea[^>]*>/g) ?? [];
  assert.equal(box.length, 1);
  assert.ok(box[0]!.includes(`maxLength="${ANSWER_MAX_CHARS}"`), box[0]);
  assert.equal(ANSWER_MAX_CHARS, 4000);
});

const MARK: Mark = {
  questionId: "dddddddd-0000-0000-0000-0000000000a1",
  orderIndex: 0,
  status: "ai_provisional",
  score: 2,
  maxScore: 5,
  feedbackMd: "Name <script>alert(1)</script> **why** the pressure differs.",
  review: "none",
  canAskForReview: true,
};
const render = (mark: Mark, props: { marking?: boolean; onAskForReview?: (note: string | null) => Promise<void> } = {}) =>
  renderToStaticMarkup(React.createElement(WrittenAnswerMark, { mark, ...props }));
const ask = async () => {};

test("the marker's feedback is shown as text, never as markup", () => {
  const html = render(MARK, { onAskForReview: ask });
  assert.ok(html.includes("Name &lt;script&gt;alert(1)&lt;/script&gt; **why** the pressure differs."));
  assert.equal(html.includes("<script>"), false);
  assert.ok(html.includes("Provisional mark 2/5 (marked by AI; your instructor will confirm it)"));
});

test("asking for a review is offered once, only where the answer allows it and the player can send it", () => {
  assert.ok(render(MARK, { onAskForReview: ask }).includes("Ask your instructor to look again"), "known positive");
  assert.equal(render(MARK).includes("Ask your instructor to look again"), false, "the author preview can't send one");
  assert.equal(render({ ...MARK, canAskForReview: false, review: "open" }, { onAskForReview: ask }).includes("Ask your instructor to look again"), false);
  assert.ok(render({ ...MARK, canAskForReview: false, review: "open" }, { onAskForReview: ask }).includes("You asked your instructor to look at this again."));
});

test("while the AI's mark is still expected the answer says it is being marked", () => {
  const waiting: Mark = { ...MARK, status: "awaiting_instructor", score: null, maxScore: 5, feedbackMd: null, canAskForReview: false };
  assert.ok(render(waiting, { marking: true }).includes("Marking your answer…"));
  assert.ok(render(waiting).includes("Waiting for your instructor"));
});
