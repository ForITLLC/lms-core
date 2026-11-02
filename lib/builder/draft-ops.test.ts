import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDraftOps, DraftOp, DraftOps } from "./draft-ops";
import { buildPublishPlan } from "./publish-plan";
import { DRAFT_LIMITS, DraftDoc, emptyDraft, publishProblems, type DraftBlock } from "@/lib/schema/draft";

const text = (key: string, markdown = "Body"): DraftBlock => ({ kind: "text", key, markdown });
const pkg: DraftBlock = {
  kind: "package",
  key: "pkg-1",
  launchableId: "6c1e4a52-0000-4000-8000-000000000001",
  title: "Imported module",
  standard: "scorm12",
};

function doc(): DraftDoc {
  return DraftDoc.parse({
    meta: { title: "Ground handling" },
    lessons: [
      { key: "l1", title: "One", blocks: [text("b1"), text("b2"), pkg] },
      { key: "l2", title: "Two", blocks: [text("b3")] },
    ],
  });
}

const keysOf = (d: DraftDoc) => d.lessons.map((l) => `${l.key}:${l.blocks.map((b) => b.key).join(",")}`);

function ok(result: ReturnType<typeof applyDraftOps>): DraftDoc {
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as { ok: true; doc: DraftDoc }).doc;
}

test("lessons and blocks add, move and remove by key, and the input draft is left alone", () => {
  const before = doc();
  const after = ok(
    applyDraftOps(before, [
      { op: "addLesson", lesson: { key: "l0", title: "Zero", estMinutes: 5, blocks: [] }, at: 0 },
      { op: "moveLesson", lessonKey: "l2", to: 1 },
      { op: "addBlock", lessonKey: "l0", block: text("b4") },
      { op: "moveBlock", lessonKey: "l1", blockKey: "b2", toLessonKey: "l2", to: 0 },
      { op: "removeBlock", lessonKey: "l1", blockKey: "b1" },
    ]),
  );
  assert.deepEqual(keysOf(after), ["l0:b4", "l2:b2,b3", "l1:pkg-1"]);
  assert.deepEqual(keysOf(before), ["l1:b1,b2,pkg-1", "l2:b3"]);
  const removed = ok(applyDraftOps(after, [{ op: "removeLesson", lessonKey: "l0" }]));
  assert.deepEqual(keysOf(removed), ["l2:b2,b3", "l1:pkg-1"]);
});

test("a position past the end appends", () => {
  const after = ok(applyDraftOps(doc(), [{ op: "addBlock", lessonKey: "l2", block: text("b9"), at: 99 }]));
  assert.deepEqual(keysOf(after)[1], "l2:b3,b9");
});

test("setMeta and updateLesson change only the fields they name", () => {
  const after = ok(
    applyDraftOps(doc(), [
      { op: "setMeta", meta: { description: "Ramp safety", tags: ["ramp"] } },
      { op: "updateLesson", lessonKey: "l2", estMinutes: 12 },
    ]),
  );
  assert.equal(after.meta.title, "Ground handling");
  assert.equal(after.meta.description, "Ramp safety");
  assert.deepEqual(after.meta.tags, ["ramp"]);
  assert.equal(after.lessons[1]!.title, "Two");
  assert.equal(after.lessons[1]!.estMinutes, 12);
});

test("updateBlock replaces the block with the same key", () => {
  const after = ok(applyDraftOps(doc(), [{ op: "updateBlock", lessonKey: "l1", block: { kind: "callout", key: "b2", variant: "warning", markdown: "Mind the prop" } }]));
  assert.deepEqual(after.lessons[0]!.blocks[1], { kind: "callout", key: "b2", variant: "warning", markdown: "Mind the prop" });
});

test("a package block can be moved or removed but never added or edited", () => {
  const original = doc();
  const edits: DraftOp[] = [
    { op: "addBlock", lessonKey: "l2", block: { ...pkg, key: "pkg-2" } },
    { op: "updateBlock", lessonKey: "l1", block: { ...pkg, title: "Renamed" } },
    { op: "updateBlock", lessonKey: "l1", block: text("pkg-1") },
    { op: "updateBlock", lessonKey: "l1", block: { ...pkg, key: "b1" } },
    { op: "addLesson", lesson: { key: "l9", title: "Nine", estMinutes: null, blocks: [{ ...pkg, key: "pkg-3" }] } },
  ];
  for (const op of edits) {
    const result = applyDraftOps(original, [op]);
    assert.equal(result.ok, false, op.op);
    assert.match((result as { error: string }).error, /package/);
  }
  const moved = ok(applyDraftOps(original, [{ op: "moveBlock", lessonKey: "l1", blockKey: "pkg-1", toLessonKey: "l2", to: 0 }]));
  assert.deepEqual(keysOf(moved), ["l1:b1,b2", "l2:pkg-1,b3"]);
  ok(applyDraftOps(original, [{ op: "removeBlock", lessonKey: "l1", blockKey: "pkg-1" }]));
});

test("a removed package block publishes without it, and only discarding the draft brings it back", () => {
  const original = doc();
  const kinds = (d: DraftDoc) => {
    const planned = buildPublishPlan(d);
    assert.equal(planned.ok, true, planned.ok ? "" : JSON.stringify(planned.problems));
    return (planned as Extract<typeof planned, { ok: true }>).plan.rows.blocks.map((b) => b.Kind);
  };
  assert.deepEqual(kinds(original), ["text", "text", "package", "text"]);

  const removed = ok(applyDraftOps(original, [{ op: "removeBlock", lessonKey: "l1", blockKey: "pkg-1" }]));
  assert.deepEqual(keysOf(removed), ["l1:b1,b2", "l2:b3"]);
  assert.deepEqual(publishProblems(removed), []);
  assert.deepEqual(kinds(removed), ["text", "text", "text"]);
  for (const putBack of [
    { op: "addBlock", lessonKey: "l1", block: pkg },
    { op: "addLesson", lesson: { key: "l9", title: "Nine", estMinutes: null, blocks: [pkg] } },
  ] as DraftOp[]) {
    const result = applyDraftOps(removed, [putBack]);
    assert.equal(result.ok, false, putBack.op);
  }
  assert.deepEqual(keysOf(original), ["l1:b1,b2,pkg-1", "l2:b3"], "the draft it came from still has it");

  const withoutLesson = ok(applyDraftOps(original, [{ op: "removeLesson", lessonKey: "l1" }]));
  assert.deepEqual(kinds(withoutLesson), ["text"]);

  const packageOnly = DraftDoc.parse({ meta: { title: "Imported" }, lessons: [{ key: "l1", title: "One", blocks: [pkg] }] });
  const emptied = ok(applyDraftOps(packageOnly, [{ op: "removeBlock", lessonKey: "l1", blockKey: "pkg-1" }]));
  assert.deepEqual(publishProblems(emptied), [{ where: "Lesson 1", problem: "The lesson has no content." }]);
});

test("unknown keys, reused keys and oversize drafts are refused whole", () => {
  const original = doc();
  const refused = (ops: unknown[]) => {
    const result = applyDraftOps(original, ops as never);
    assert.equal(result.ok, false, JSON.stringify(ops));
  };
  refused([{ op: "removeLesson", lessonKey: "nope" }]);
  refused([{ op: "removeBlock", lessonKey: "l1", blockKey: "b3" }]);
  refused([{ op: "moveBlock", lessonKey: "l1", blockKey: "b1", toLessonKey: "nope", to: 0 }]);
  refused([{ op: "addBlock", lessonKey: "l2", block: text("b1") }]);
  refused([{ op: "addLesson", lesson: { key: "b3", title: "Clash", estMinutes: null, blocks: [] } }]);
  refused([
    { op: "addBlock", lessonKey: "l2", block: text("ok-1") },
    { op: "removeLesson", lessonKey: "nope" },
  ]);
  const huge = "x".repeat(DRAFT_LIMITS.docBytes);
  refused([{ op: "addBlock", lessonKey: "l2", block: text("big", huge) }]);
  assert.deepEqual(keysOf(original), ["l1:b1,b2,pkg-1", "l2:b3"]);
});

test("the wire format rejects unknown ops, bad keys and empty batches", () => {
  assert.equal(DraftOps.safeParse([]).success, false);
  assert.equal(DraftOps.safeParse([{ op: "dropTable" }]).success, false);
  assert.equal(DraftOps.safeParse([{ op: "removeLesson", lessonKey: "a b" }]).success, false);
  assert.equal(DraftOps.safeParse([{ op: "moveLesson", lessonKey: "l1", to: -1 }]).success, false);
  assert.equal(DraftOps.safeParse([{ op: "removeLesson", lessonKey: "l1" }]).success, true);
});

test("the wire format refuses a block address that isn't http(s), in addBlock, updateBlock and addLesson", () => {
  const embed = (url: string) => ({ kind: "embed", key: "e1", url, provider: "other" });
  for (const url of ["javascript:alert(1)", " JavaScript:alert(1)", "data:text/html,x", "vbscript:x", "//evil.com"]) {
    assert.equal(DraftOp.safeParse({ op: "addBlock", lessonKey: "l1", block: embed(url) }).success, false, url);
    assert.equal(DraftOp.safeParse({ op: "updateBlock", lessonKey: "l1", block: embed(url) }).success, false, url);
    assert.equal(DraftOp.safeParse({ op: "addLesson", lesson: { key: "l9", title: "x", blocks: [embed(url)] } }).success, false, url);
    assert.equal(DraftOp.safeParse({ op: "addBlock", lessonKey: "l1", block: { kind: "image", key: "i1", url } }).success, false, url);
  }
  assert.equal(DraftOp.safeParse({ op: "addBlock", lessonKey: "l1", block: embed("https://www.youtube.com/watch?v=abc") }).success, true);
});

test("a draft saves incomplete; publishProblems says what stops it publishing", () => {
  const draft = DraftDoc.parse({
    meta: { title: " ", scheduleKind: "recurring" },
    lessons: [
      { key: "l1", title: "", blocks: [] },
      {
        key: "l2",
        title: "Quiz",
        blocks: [
          { kind: "text", key: "t", markdown: "  " },
          { kind: "quiz", key: "q0", questions: [] },
          {
            kind: "quiz",
            key: "q1",
            questions: [
              { kind: "mcq", promptMd: "Which?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "c" },
              { kind: "multi", promptMd: "Which ones?", choices: [{ id: "a", label: "A" }, { id: "a", label: "" }], correctChoiceIds: ["a", "a"] },
              { kind: "short", promptMd: "", rubricMd: "", maxScore: 5 },
              { kind: "tf", promptMd: "Fine?", correctValue: true },
            ],
          },
        ],
      },
    ],
  });
  const problems = publishProblems(draft).map((p) => `${p.where}: ${p.problem}`);
  assert.deepEqual(problems, [
    "Course: The course has no title.",
    "Course: A recurring course needs the number of months between renewals.",
    "Lesson 1: The lesson has no title.",
    "Lesson 1: The lesson has no content.",
    "Lesson 2, block 1: The text is empty.",
    "Lesson 2, block 2: The quiz has no questions.",
    "Lesson 2, block 3, question 1: The correct answer is not one of the answers.",
    "Lesson 2, block 3, question 2: Two answers share an id.",
    "Lesson 2, block 3, question 2: An answer is empty.",
    "Lesson 2, block 3, question 2: A correct answer is listed twice.",
    "Lesson 2, block 3, question 3: The question has no wording.",
    "Lesson 2, block 3, question 3: The question has no marking rubric.",
  ]);
  assert.deepEqual(publishProblems(emptyDraft({ title: "New" })), [{ where: "Course", problem: "Add at least one lesson." }]);
  assert.deepEqual(publishProblems(doc()), []);
});
