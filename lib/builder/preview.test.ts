import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftDoc } from "@/lib/schema/draft";
import { stripBlock } from "@/lib/mobile/course";
import { buildPreview, previewId, previewQuiz } from "./preview";

// The preview turns a draft into the learner player's props the learner page's
// way (tokens resolved, then stripBlock), with ids derived from editor keys.

const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";
const PUBLISHED_BLOCK = "dddddddd-0000-0000-0000-000000000001";
const LAUNCHABLE = "dddddddd-0000-0000-0000-000000000002";

const doc = DraftDoc.parse({
  meta: { title: "Ramp safety", requiresQuizPass: true },
  lessons: [
    {
      key: "l1",
      title: "Walkaround",
      estMinutes: 5,
      blocks: [
        { kind: "text", key: PUBLISHED_BLOCK, markdown: "Ask {{support_email}}" },
        { kind: "package", key: "pkg", launchableId: LAUNCHABLE, title: "Ramp sim", standard: "cmi5" },
        { kind: "quiz", key: "q1", passingScore: 80, questions: [
          { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" },
          { kind: "short", promptMd: "Why?", rubricMd: "Mentions FOD", maxScore: 3 },
        ] },
      ],
    },
    { key: "l2", title: "Fuelling", blocks: [{ kind: "roleplay", key: "rp", persona: "Captain", scenario: "Late fuel", rubricMd: "Stays calm" }] },
  ],
});

const tokens = { company_name: "Acme Air", support_email: "ops@example.test" };

test("lessons and blocks keep their order, with stable ids that never equal a key", () => {
  const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc, tokens);
  assert.deepEqual(preview.lessons.map((l) => [l.Title, l.OrderIndex, l.EstMinutes]), [["Walkaround", 0, 5], ["Fuelling", 1, null]]);
  assert.deepEqual(preview.lessons[0]!.blocks.map((b) => b.kind), ["text", "package", "quiz"]);
  assert.deepEqual(preview.lessons[1]!.blocks.map((b) => b.kind), ["roleplay"]);

  const again = buildPreview({ courseId: COURSE.toUpperCase(), slug: "ramp-safety" }, doc, tokens);
  assert.deepEqual(again, preview, "the same draft previews with the same ids");
  const ids = preview.lessons.flatMap((l) => [l.LessonId, ...l.blocks.map((b) => b.blockId)]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(!ids.includes(PUBLISHED_BLOCK), "a key copied from a published block id is not reused as the preview id");
  assert.equal(preview.lessons[0]!.blocks[0]!.blockId, previewId(COURSE, "block", PUBLISHED_BLOCK));
  const other = buildPreview({ courseId: "c0c0c0c0-0000-0000-0000-0000000000ff", slug: "x" }, doc, tokens);
  assert.notEqual(other.lessons[0]!.blocks[0]!.blockId, preview.lessons[0]!.blocks[0]!.blockId);
});

test("blocks go through stripBlock: answer keys and rubrics gone, package blocks kept for PackageNotice", () => {
  const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc, tokens);
  const [text, pkg, quiz] = preview.lessons[0]!.blocks;
  assert.deepEqual(pkg, { kind: "package", blockId: previewId(COURSE, "block", "pkg"), launchableId: LAUNCHABLE, title: "Ramp sim", standard: "cmi5" });
  if (quiz?.kind !== "quiz") return assert.fail("the third block is the quiz");
  assert.deepEqual(quiz.questions, [
    { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { kind: "short", promptMd: "Why?", maxScore: 3 },
  ]);
  assert.deepEqual(quiz, stripBlock({ kind: "quiz", blockId: quiz.blockId, quizId: quiz.quizId, questions: doc.lessons[0]!.blocks[2]!.kind === "quiz" ? doc.lessons[0]!.blocks[2]!.questions : [] }));
  assert.deepEqual(preview.lessons[1]!.blocks[0], { kind: "roleplay", blockId: previewId(COURSE, "block", "rp"), persona: "Captain", scenario: "Late fuel" });
  assert.deepEqual(Object.keys(text!).sort(), ["blockId", "kind", "markdown"], "the editor key is not passed on");
  const json = JSON.stringify(preview);
  for (const secret of ["correctChoiceId", "rubricMd", "Mentions FOD", "Stays calm", "passingScore"]) assert.ok(!json.includes(secret), secret);
});

test("tenant tokens resolve as on the learner page, and quizzes are named back to their block keys", () => {
  const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc, tokens);
  const text = preview.lessons[0]!.blocks[0]!;
  assert.equal(text.kind === "text" && text.markdown, "Ask ops@example.test");
  assert.deepEqual(preview.course, { CourseId: COURSE, Title: "Ramp safety", Slug: "ramp-safety" });
  assert.equal(preview.requiresQuizPass, true);
  const quiz = preview.lessons[0]!.blocks[2]!;
  assert.equal(quiz.kind, "quiz");
  if (quiz.kind === "quiz") {
    assert.deepEqual(preview.quizKeys, { [quiz.quizId]: "q1" });
    assert.notEqual(quiz.quizId, quiz.blockId);
  }
});

test("the completion gate's inputs: package blocks are counted, and a quiz with no questions is left out as the learner gate leaves it out", () => {
  assert.equal(buildPreview({ courseId: COURSE, slug: "ramp-safety" }, doc, tokens).packageBlocks, 1);
  const withEmpty = DraftDoc.parse({
    ...doc,
    lessons: [...doc.lessons, { key: "l3", title: "Wrap-up", blocks: [{ kind: "quiz", key: "q-empty", questions: [] }, { kind: "package", key: "pkg2", launchableId: LAUNCHABLE, title: "Debrief", standard: "scorm12" }] }],
  });
  const preview = buildPreview({ courseId: COURSE, slug: "ramp-safety" }, withEmpty, tokens);
  const empty = preview.lessons[2]!.blocks[0]!;
  assert.ok(empty.kind === "quiz" && empty.questions.length === 0, "the empty quiz is still in the lessons");
  assert.deepEqual(Object.values(preview.quizKeys), ["q1"]);
  assert.equal(preview.packageBlocks, 2);
});

test("previewQuiz hands the grader the block's questions by position, and says when a key is missing or not a quiz", () => {
  const quiz = previewQuiz(doc, "q1");
  assert.equal(quiz.kind, "quiz");
  if (quiz.kind === "quiz") {
    assert.equal(quiz.passingScore, 80);
    assert.deepEqual(quiz.questions.map((q) => [q.orderIndex, q.question.kind]), [[0, "mcq"], [1, "short"]]);
    assert.equal(quiz.questions[0]!.question.kind === "mcq" && quiz.questions[0]!.question.correctChoiceId, "b");
  }
  assert.deepEqual(previewQuiz(doc, "rp"), { kind: "not_quiz" });
  assert.deepEqual(previewQuiz(doc, "nope"), { kind: "missing" });
  assert.deepEqual(previewQuiz(doc, "l1"), { kind: "missing" }, "a lesson key is not a block");
});
