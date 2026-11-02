import { test } from "node:test";
import assert from "node:assert/strict";
import { toDraftDoc, UnreadableBlockError, UnreadableVersionError, type VersionContent } from "./fork";

const L1 = "11111111-1111-1111-1111-111111111111";
const L2 = "22222222-2222-2222-2222-222222222222";
const QB = "33333333-3333-3333-3333-333333333333";
const QZ = "44444444-4444-4444-4444-444444444444";
const PK = "55555555-5555-5555-5555-555555555555";
const LAUNCHABLE = "66666666-6666-6666-6666-666666666666";

function content(over: Partial<VersionContent> = {}): VersionContent {
  return {
    course: {
      Title: "Dangerous goods",
      Description: null,
      Category: "security",
      Tags: JSON.stringify(["dg", "", 7, " cargo "]),
      ScheduleKind: "recurring",
      RecurrenceMonths: 24,
      RequiresQuizPass: true,
    },
    lessons: [
      { LessonId: L2, Title: "Second", OrderIndex: 1, EstMinutes: null },
      { LessonId: L1, Title: "First", OrderIndex: 0, EstMinutes: 10 },
    ],
    blocks: [
      { BlockId: QB, LessonId: L1, OrderIndex: 1, PayloadJson: JSON.stringify({ kind: "quiz", quizId: QZ }) },
      { BlockId: "AAAAAAAA-0000-0000-0000-000000000001", LessonId: L1, OrderIndex: 0, PayloadJson: JSON.stringify({ kind: "text", markdown: "Intro" }) },
      { BlockId: PK, LessonId: L2, OrderIndex: 0, PayloadJson: JSON.stringify({ kind: "package", launchableId: LAUNCHABLE, title: "Module", standard: "cmi5" }) },
    ],
    quizzes: [{ QuizId: QZ.toUpperCase(), BlockId: QB.toUpperCase(), PassingScore: 80, IsExam: true }],
    questions: [
      { QuizId: QZ, OrderIndex: 1, PayloadJson: JSON.stringify({ kind: "tf", promptMd: "Second?", correctValue: false }) },
      { QuizId: QZ, OrderIndex: 0, PayloadJson: JSON.stringify({ kind: "mcq", promptMd: "First?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" }) },
    ],
    ...over,
  };
}

test("a published version becomes a draft in lesson and block order, with its quiz inline", () => {
  const doc = toDraftDoc(content());
  assert.deepEqual(doc.meta, {
    title: "Dangerous goods",
    description: "",
    category: "security",
    tags: ["dg", "cargo"],
    scheduleKind: "recurring",
    recurrenceMonths: 24,
    requiresQuizPass: true,
  });
  assert.deepEqual(doc.lessons.map((l) => [l.key, l.title, l.estMinutes]), [[L1, "First", 10], [L2, "Second", null]]);
  assert.deepEqual(doc.lessons[0]!.blocks[0], { kind: "text", key: "aaaaaaaa-0000-0000-0000-000000000001", markdown: "Intro" });
  const quiz = doc.lessons[0]!.blocks[1]!;
  assert.equal(quiz.kind, "quiz");
  if (quiz.kind !== "quiz") return;
  assert.equal(quiz.key, QB);
  assert.equal(quiz.passingScore, 80);
  assert.equal(quiz.isExam, true, "an exam reopens as an exam");
  assert.deepEqual(quiz.questions.map((q) => q.promptMd), ["First?", "Second?"]);
  assert.equal("quizId" in quiz, false);
});

test("a practice quiz reopens as a practice quiz", () => {
  const practice = content({ quizzes: [{ QuizId: QZ, BlockId: QB, PassingScore: 80, IsExam: false }] });
  const quiz = toDraftDoc(practice).lessons[0]!.blocks[1]!;
  assert.equal(quiz.kind === "quiz" && quiz.isExam, false);
});

test("a package block survives the copy untouched", () => {
  const doc = toDraftDoc(content());
  assert.deepEqual(doc.lessons[1]!.blocks, [{ kind: "package", key: PK, launchableId: LAUNCHABLE, title: "Module", standard: "cmi5" }]);
});

test("a block or question the builder can't read stops the copy and says where", () => {
  const badBlock = content();
  badBlock.blocks[1] = { ...badBlock.blocks[1]!, PayloadJson: "{not json" };
  assert.throws(() => toDraftDoc(badBlock), (e: unknown) => e instanceof UnreadableBlockError && e.message.startsWith("Lesson 1, block 1 "));

  const lostQuiz = content({ quizzes: [] });
  assert.throws(() => toDraftDoc(lostQuiz), (e: unknown) => e instanceof UnreadableBlockError && e.message.startsWith("Lesson 1, block 2 "));

  const badQuestion = content();
  badQuestion.questions[0] = { ...badQuestion.questions[0]!, PayloadJson: JSON.stringify({ kind: "essay" }) };
  assert.throws(() => toDraftDoc(badQuestion), UnreadableBlockError);
});

test("a course with no tags or an unparseable tag list gets none", () => {
  for (const Tags of [null, "not json", JSON.stringify({ a: 1 })]) {
    assert.deepEqual(toDraftDoc(content({ course: { ...content().course, Tags } })).meta.tags, []);
  }
});

test("a published value the draft can't hold stops the copy instead of being dropped", () => {
  const longTag = content({ course: { ...content().course, Tags: JSON.stringify(["dg", "x".repeat(41)]) } });
  assert.throws(() => toDraftDoc(longTag), (e: unknown) => e instanceof UnreadableVersionError && /meta\.tags\.1/.test((e as Error).message));
  const longLesson = content({ lessons: [{ LessonId: L1, Title: "First", OrderIndex: 0, EstMinutes: 900 }] });
  assert.throws(() => toDraftDoc(longLesson), UnreadableVersionError);
});
