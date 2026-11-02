import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPublishPlan } from "./publish-plan";
import { Block } from "@/lib/schema/blocks";
import { DraftDoc } from "@/lib/schema/draft";
import { QuizQuestion } from "@/lib/schema/quiz";

const LAUNCHABLE = "6c1e4a52-0000-4000-8000-000000000001";

function draft(over: Record<string, unknown> = {}): DraftDoc {
  return DraftDoc.parse({
    meta: { title: "  Ramp safety ", description: "", tags: ["ramp", "ops"], scheduleKind: "annual", recurrenceMonths: 12 },
    lessons: [
      {
        key: "l1",
        title: " Walkaround ",
        estMinutes: 10,
        blocks: [
          { kind: "text", key: "b1", markdown: "Check the chocks." },
          {
            kind: "quiz",
            key: "q1",
            passingScore: 80,
            questions: [
              { kind: "tf", promptMd: "Chocks first?", correctValue: true },
              { kind: "mcq", promptMd: "Which?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "a" },
            ],
          },
        ],
      },
      { key: "l2", title: "Imported", blocks: [{ kind: "package", key: "pkg-1", launchableId: LAUNCHABLE, title: "Module", standard: "cmi5" }] },
    ],
    ...over,
  });
}

function counter() {
  let n = 0;
  return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
}

test("every row gets a fresh id, never the editor key, in draft order", () => {
  const result = buildPublishPlan(draft(), counter());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const { lessons, blocks, quizzes, questions } = result.plan.rows;

  assert.deepEqual(lessons.map((l) => [l.Title, l.OrderIndex, l.EstMinutes]), [["Walkaround", 0, 10], ["Imported", 1, null]]);
  assert.deepEqual(blocks.map((b) => [b.Kind, b.OrderIndex, b.LessonId]), [
    ["text", 0, lessons[0]!.LessonId],
    ["quiz", 1, lessons[0]!.LessonId],
    ["package", 0, lessons[1]!.LessonId],
  ]);
  const ids = [...lessons.map((l) => l.LessonId), ...blocks.map((b) => b.BlockId), ...quizzes.map((q) => q.QuizId), ...questions.map((q) => q.QuestionId)];
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^00000000-0000-4000-8000-/);
  for (const b of blocks) assert.equal("key" in JSON.parse(b.PayloadJson), false);
});

test("a quiz becomes a quiz row, its questions, and a block that points at it", () => {
  const result = buildPublishPlan(draft(), counter());
  if (!result.ok) return assert.fail("not publishable");
  const { blocks, quizzes, questions } = result.plan.rows;
  const quizBlock = blocks.find((b) => b.Kind === "quiz")!;
  assert.deepEqual(quizzes, [{ QuizId: quizzes[0]!.QuizId, BlockId: quizBlock.BlockId, PassingScore: 80, IsExam: false }]);
  assert.deepEqual(JSON.parse(quizBlock.PayloadJson), { kind: "quiz", quizId: quizzes[0]!.QuizId });
  assert.equal(Block.safeParse(JSON.parse(quizBlock.PayloadJson)).success, true);
  assert.deepEqual(questions.map((q) => [q.QuizId, q.Kind, q.OrderIndex, q.PromptMd]), [
    [quizzes[0]!.QuizId, "tf", 0, "Chocks first?"],
    [quizzes[0]!.QuizId, "mcq", 1, "Which?"],
  ]);
  for (const q of questions) assert.equal(QuizQuestion.safeParse(JSON.parse(q.PayloadJson)).success, true);
});

test("a quiz is an exam only when its author ticked the box, and the row carries it", () => {
  const exam = draft({
    lessons: [{
      key: "l1",
      title: "Exams",
      blocks: [
        { kind: "quiz", key: "q-exam", isExam: true, questions: [{ kind: "tf", promptMd: "Chocks first?", correctValue: true }] },
        { kind: "quiz", key: "q-practice", isExam: false, questions: [{ kind: "tf", promptMd: "Chocks first?", correctValue: true }] },
        { kind: "quiz", key: "q-unset", questions: [{ kind: "tf", promptMd: "Chocks first?", correctValue: true }] },
      ],
    }],
  });
  const result = buildPublishPlan(exam, counter());
  if (!result.ok) return assert.fail("not publishable");
  assert.deepEqual(result.plan.rows.quizzes.map((q) => q.IsExam), [true, false, false]);
  for (const b of result.plan.rows.blocks) assert.equal("isExam" in JSON.parse(b.PayloadJson), false, "the flag lives on lms.Quiz, not in the block");
});

test("a package block is published as the same launchable", () => {
  const result = buildPublishPlan(draft(), counter());
  if (!result.ok) return assert.fail("not publishable");
  const pkg = result.plan.rows.blocks.find((b) => b.Kind === "package")!;
  assert.deepEqual(JSON.parse(pkg.PayloadJson), { kind: "package", launchableId: LAUNCHABLE, title: "Module", standard: "cmi5" });
});

test("course fields are tidied for the course row", () => {
  const result = buildPublishPlan(draft(), counter());
  if (!result.ok) return assert.fail("not publishable");
  assert.deepEqual(result.plan.course, {
    title: "Ramp safety",
    description: null,
    category: null,
    tags: JSON.stringify(["ramp", "ops"]),
    scheduleKind: "annual",
    recurrenceMonths: null,
    requiresQuizPass: false,
  });
  const untagged = buildPublishPlan(draft({ meta: { title: "T", tags: [], scheduleKind: "recurring", recurrenceMonths: 24 } }), counter());
  if (!untagged.ok) return assert.fail("not publishable");
  assert.equal(untagged.plan.course.tags, null);
  assert.equal(untagged.plan.course.recurrenceMonths, 24);
});

test("a draft with problems gives the problems and no rows", () => {
  const result = buildPublishPlan(draft({ lessons: [] }), counter());
  assert.deepEqual(result, { ok: false, problems: [{ where: "Course", problem: "Add at least one lesson." }] });
});
