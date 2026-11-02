import { test } from "node:test";
import assert from "node:assert/strict";
import { stripBlock, toMobileCourse } from "./course";

test("quiz blocks reach the device without answer keys or rubrics", () => {
  const block = stripBlock({
    kind: "quiz",
    blockId: "B1",
    quizId: "Q1",
    questions: [
      { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "a" },
      { kind: "multi", promptMd: "Pick all", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceIds: ["a", "b"] },
      { kind: "tf", promptMd: "True?", correctValue: true },
      { kind: "short", promptMd: "Explain", rubricMd: "Mentions X", maxScore: 5 },
      { kind: "confidence", promptMd: "Sure?", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" },
    ],
  });
  const json = JSON.stringify(block);
  for (const leak of ["correctChoiceId", "correctChoiceIds", "correctValue", "rubricMd", "Mentions X"]) {
    assert.equal(json.includes(leak), false, `${leak} leaked`);
  }
  assert.equal(block.kind, "quiz");
});

test("roleplay rubric is stripped; content blocks pass through", () => {
  assert.equal(
    JSON.stringify(stripBlock({ kind: "roleplay", blockId: "B2", persona: "P", scenario: "S", rubricMd: "secret" })).includes("secret"),
    false,
  );
  const text = { kind: "text" as const, blockId: "B3", markdown: "# Hi" };
  assert.deepEqual(stripBlock(text), text);
});

test("a package block reaches the device as kind, block id, launchable, title and standard only", () => {
  const stored = {
    kind: "package" as const,
    blockId: "B4",
    launchableId: "0a000002-0000-4000-8000-000000000002",
    title: "Golf: basic runtime calls",
    standard: "cmi5" as const,
  };
  const leaky = { ...stored, launchUrl: "https://content.test/index.html?token=secret", fetchToken: "secret" };
  const block = stripBlock(leaky);
  assert.deepEqual(block, stored);
  assert.deepEqual(Object.keys(block).sort(), ["blockId", "kind", "launchableId", "standard", "title"]);
  assert.equal(JSON.stringify(block).includes("secret"), false);
});

test("lessons are ordered and progress rides along", () => {
  const course = toMobileCourse(
    {
      course: {
        CourseId: "C1", Title: "T", Slug: "t", Description: null, Status: "published", Category: null, Tags: [],
        UpdatedAt: new Date(0), OwnerUserId: null, OwnerGroupId: null, OwnerGroupName: null, OwnerName: null,
        IsCatalog: false, IsCatalogSubscribed: false, CurrentVersionId: "V1",
      },
      versionId: "V1",
      lessons: [
        { LessonId: "L2", Title: "Two", OrderIndex: 2, EstMinutes: 5, blocks: [] },
        { LessonId: "L1", Title: "One", OrderIndex: 1, EstMinutes: null, blocks: [] },
      ],
    },
    ["B1"],
    { totalBlocks: 2, completedBlocks: 1, pct: 50, completed: false },
  );
  assert.deepEqual(course.lessons.map((l) => l.lesson_id), ["L1", "L2"]);
  assert.deepEqual(course.seen_block_ids, ["B1"]);
  assert.equal(course.progress.pct, 50);
});
