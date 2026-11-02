import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftOp, applyDraftOps } from "@/lib/builder/draft-ops";
import { DRAFT_LIMITS, META_LIMITS, emptyDraft, publishProblems } from "@/lib/schema/draft";
import type { QuizQuestion } from "@/lib/schema/quiz";
import {
  addTags,
  blankQuestion,
  blockLimit,
  blockSaveError,
  failedField,
  hasUnsavedWork,
  isImageSource,
  isLayoutOp,
  isWebUrl,
  lessonLimit,
  numberText,
  numberTextError,
  parseNumberText,
  publishBlockReason,
  questionLimit,
  removeBlockPrompt,
  removeTag,
  resyncField,
  sameJson,
  saveStatusLabel,
  scheduleChoice,
  sentField,
  settingsPatch,
  syncedField,
  toggledSet,
  versionCounts,
  type BlockOf,
  type SettingsForm,
} from "./draft-helpers";

const calm = { saving: false, conflict: false, saveFailed: false, dirty: false };

test("the save status says what is true, most urgent first", () => {
  assert.equal(saveStatusLabel(calm), "All changes saved");
  assert.equal(saveStatusLabel({ ...calm, dirty: true }), "Unsaved changes");
  assert.equal(saveStatusLabel({ ...calm, saveFailed: true }), "Not saved");
  assert.equal(saveStatusLabel({ ...calm, saveFailed: true, dirty: true }), "Not saved");
  assert.equal(saveStatusLabel({ ...calm, conflict: true }), "Not saved");
  assert.equal(saveStatusLabel({ ...calm, saving: true, saveFailed: true, dirty: true }), "Saving…");
});

test("leaving the page warns while anything is unsaved, queued or failed", () => {
  assert.equal(hasUnsavedWork(calm), false);
  assert.equal(hasUnsavedWork({ ...calm, dirty: true }), true);
  assert.equal(hasUnsavedWork({ ...calm, saving: true }), true);
  assert.equal(hasUnsavedWork({ ...calm, saveFailed: true }), true);
});

test("publish waits for open edits and a stale draft, not for a save in flight", () => {
  assert.equal(publishBlockReason({ locked: false, dirty: false }), null);
  assert.equal(publishBlockReason({ locked: false, dirty: true }), "Save or cancel your open edits before publishing.");
  assert.match(publishBlockReason({ locked: true, dirty: true }) ?? "", /Reload/);
});

test("a server reply replaces a field only when nothing was typed since the send", () => {
  const start = syncedField("Intro");
  assert.equal(resyncField(start, "Intro"), start, "an unchanged reply keeps the same state");

  const typed = { ...start, local: "Intro to" };
  const sent = sentField(typed);
  assert.deepEqual(sent, { local: "Intro to", sent: "Intro to", server: "Intro" });

  assert.deepEqual(resyncField(sent, "Intro to"), syncedField("Intro to"), "own reply lands");
  assert.deepEqual(resyncField(sent, "Intro to "), syncedField("Intro to "), "a server-normalised value is adopted");

  const typingOn = { ...sent, local: "Intro to safety" };
  assert.deepEqual(resyncField(typingOn, "Intro to"), { local: "Intro to safety", sent: "Intro to", server: "Intro to" });

  const reloaded = resyncField(start, "Renamed elsewhere");
  assert.deepEqual(reloaded, syncedField("Renamed elsewhere"), "an untouched field follows a reload");
  const keepTyping = resyncField({ ...start, local: "Mine" }, "Renamed elsewhere");
  assert.equal(keepTyping.local, "Mine", "unsent typing survives a reload");
});

test("a failed save leaves the typed value unsent so it can be saved again", () => {
  const sent = sentField({ ...syncedField("Old"), local: "New" });
  const failed = failedField(sent);
  assert.deepEqual(failed, { local: "New", sent: "Old", server: "Old" });
  assert.equal(resyncField(failed, "Old"), failed);
  const otherReply = resyncField(failed, "Old");
  assert.equal(otherReply.local, "New");
});

test("block fields resync by content, so another block's save leaves an open editor alone", () => {
  const block = { kind: "text" as const, key: "b1", markdown: "Saved" };
  const editing = { ...syncedField(block), local: { ...block, markdown: "Typing" } };
  const sameContent = resyncField(editing, { ...block }, sameJson);
  assert.equal(sameContent, editing);
  const untouched = syncedField(block);
  assert.equal(resyncField(untouched, { ...block }, sameJson), untouched);
});

test("number boxes pass on what was typed and say when it is out of range", () => {
  assert.equal(parseNumberText("150", false), 150);
  assert.ok(Number.isNaN(parseNumberText("", false) as number));
  assert.equal(parseNumberText("  ", true), null);
  assert.equal(numberText(70), "70");
  assert.equal(numberText(null), "");
  assert.equal(numberText(Number.NaN), "");
  assert.equal(numberTextError("70", 1, 100, false), null);
  assert.equal(numberTextError("", 1, 100, true), null);
  for (const bad of ["150", "0", "", "7.5", "abc"]) {
    assert.equal(numberTextError(bad, 1, 100, false), "Enter a whole number from 1 to 100.", bad);
  }
});

const quiz = (patch: Partial<BlockOf<"quiz">> = {}): BlockOf<"quiz"> => ({ kind: "quiz", key: "q1", passingScore: 70, isExam: false, questions: [], ...patch });

test("an out-of-range score reaches the block and blocks saving it", () => {
  assert.equal(blockSaveError(quiz()), null);
  for (const passingScore of [150, 0, Number.NaN]) {
    assert.equal(blockSaveError(quiz({ passingScore })), "The passing score must be a whole number from 1 to 100.");
  }
  const short = (maxScore: number): QuizQuestion => ({ kind: "short", promptMd: "Why?", rubricMd: "Because", maxScore });
  assert.equal(blockSaveError(quiz({ questions: [blankQuestion("tf"), short(5)] })), null);
  assert.equal(blockSaveError(quiz({ questions: [blankQuestion("tf"), short(0)] })), "Question 2: the marks must be a whole number from 1 to 100.");
  assert.equal(blockSaveError(quiz({ questions: [short(Number.NaN)] })), "Question 1: the marks must be a whole number from 1 to 100.");
  const tooMany = Array.from({ length: DRAFT_LIMITS.questionsPerQuiz + 1 }, () => blankQuestion("tf"));
  assert.match(blockSaveError(quiz({ questions: tooMany })) ?? "", new RegExp(`up to ${DRAFT_LIMITS.questionsPerQuiz} questions`));
});

test("add buttons stop at the draft limits the server enforces", () => {
  const cases: [(n: number) => string | null, number][] = [
    [lessonLimit, DRAFT_LIMITS.lessons],
    [blockLimit, DRAFT_LIMITS.blocksPerLesson],
    [questionLimit, DRAFT_LIMITS.questionsPerQuiz],
  ];
  for (const [limit, max] of cases) {
    assert.equal(limit(max - 1), null);
    assert.match(limit(max) ?? "", new RegExp(`up to ${max} `));
    assert.notEqual(limit(max + 1), null);
  }
});

test("only edits that reshape the doc hold the move buttons", () => {
  assert.equal(isLayoutOp({ op: "moveBlock", lessonKey: "l1", blockKey: "b1", to: 0 }), true);
  assert.equal(isLayoutOp({ op: "moveLesson", lessonKey: "l1", to: 1 }), true);
  assert.equal(isLayoutOp({ op: "removeBlock", lessonKey: "l1", blockKey: "b1" }), true);
  assert.equal(isLayoutOp({ op: "addLesson", lesson: { key: "l2", title: "Two", estMinutes: null, blocks: [] } }), true);
  assert.equal(isLayoutOp({ op: "updateLesson", lessonKey: "l1", title: "New" }), false);
  assert.equal(isLayoutOp({ op: "updateBlock", lessonKey: "l1", block: { kind: "text", key: "b1", markdown: "x" } }), false);
});

test("toggledSet returns the same set when nothing changes", () => {
  const empty: ReadonlySet<string> = new Set();
  assert.equal(toggledSet(empty, "a", false), empty);
  const one = toggledSet(empty, "a", true);
  assert.deepEqual([...one], ["a"]);
  assert.equal(toggledSet(one, "a", true), one);
  assert.deepEqual([...toggledSet(one, "a", false)], []);
  assert.deepEqual([...empty], [], "the original is not mutated");
});

test("the editor's address checks are the schema's: no javascript:, no //host image", () => {
  for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "//evil.example/x.png", "/\\evil.example"]) {
    assert.equal(isImageSource(bad), false, bad);
    assert.equal(isWebUrl(bad), false, bad);
  }
  assert.equal(isImageSource("/images/x.png"), true);
  assert.equal(isWebUrl("https://example.com/v"), true);
});

const settings = (patch: Partial<SettingsForm> = {}): SettingsForm => ({
  category: "",
  tags: [],
  schedule: "none",
  recurrenceMonths: null,
  requiresQuizPass: false,
  pendingTag: "",
  ...patch,
});

test("tags are trimmed, added once in any case, split on commas and stop at the schema's limits", () => {
  assert.deepEqual(addTags([], "  ramp   safety "), { ok: true, tags: ["ramp safety"] });
  assert.deepEqual(addTags(["Ramp"], "ramp, de-icing,, ,DE-ICING"), { ok: true, tags: ["Ramp", "de-icing"] });
  assert.deepEqual(addTags(["ramp"], ""), { ok: true, tags: ["ramp"] });
  assert.deepEqual(addTags([], "x".repeat(META_LIMITS.tag)), { ok: true, tags: ["x".repeat(META_LIMITS.tag)] });
  assert.deepEqual(addTags([], "x".repeat(META_LIMITS.tag + 1)), { ok: false, error: `A tag can be up to ${META_LIMITS.tag} characters.` });
  const full = Array.from({ length: META_LIMITS.tags }, (_, i) => `t${i}`);
  assert.deepEqual(addTags(full, "one more"), { ok: false, error: `A course can have up to ${META_LIMITS.tags} tags.` });
  assert.deepEqual(addTags(full, "t3"), { ok: true, tags: full }, "a tag already there isn't counted again");
  assert.deepEqual(removeTag(["a", "b", "a"], "a"), ["b"]);
});

test("the settings edit is a setMeta the server accepts, or says why it can't be sent", () => {
  const sent = (form: SettingsForm) => {
    const patch = settingsPatch(form);
    assert.equal(patch.ok, true, patch.ok ? "" : patch.error);
    const meta = (patch as { ok: true; meta: unknown }).meta;
    assert.equal(DraftOp.safeParse({ op: "setMeta", meta }).success, true, JSON.stringify(meta));
    return meta;
  };
  assert.deepEqual(sent(settings({ category: "  ", pendingTag: "ramp" })), {
    category: null,
    tags: ["ramp"],
    scheduleKind: null,
    recurrenceMonths: null,
    requiresQuizPass: false,
  });
  assert.deepEqual(sent(settings({ category: ` ${"c".repeat(META_LIMITS.category)} `, schedule: "recurring", recurrenceMonths: 24, requiresQuizPass: true })), {
    category: "c".repeat(META_LIMITS.category),
    tags: [],
    scheduleKind: "recurring",
    recurrenceMonths: 24,
    requiresQuizPass: true,
  });
  assert.deepEqual(sent(settings({ schedule: "annual", recurrenceMonths: 24 })), { category: null, tags: [], scheduleKind: "annual", recurrenceMonths: null, requiresQuizPass: false }, "months only count for a recurring course");
  assert.deepEqual(sent(settings({ schedule: "none", recurrenceMonths: Number.NaN })), { category: null, tags: [], scheduleKind: null, recurrenceMonths: null, requiresQuizPass: false });
  sent(settings({ schedule: "recurring", recurrenceMonths: META_LIMITS.recurrenceMonths }));
  sent(settings({ tags: Array.from({ length: META_LIMITS.tags }, (_, i) => `t${i}`) }));

  for (const recurrenceMonths of [0, META_LIMITS.recurrenceMonths + 1, 6.5, Number.NaN]) {
    const refused = settingsPatch(settings({ schedule: "recurring", recurrenceMonths }));
    assert.equal(refused.ok, false, String(recurrenceMonths));
    assert.equal(DraftOp.safeParse({ op: "setMeta", meta: { scheduleKind: "recurring", recurrenceMonths } }).success, false, "the server would refuse it too");
  }
  assert.equal(settingsPatch(settings({ category: "c".repeat(META_LIMITS.category + 1) })).ok, false);
  assert.equal(DraftOp.safeParse({ op: "setMeta", meta: { category: "c".repeat(META_LIMITS.category + 1) } }).success, false);
  assert.deepEqual(settingsPatch(settings({ pendingTag: "x".repeat(META_LIMITS.tag + 1) })), { ok: false, error: `A tag can be up to ${META_LIMITS.tag} characters.` });
});

test("a recurring course with no months saves, and publishProblems holds it back", () => {
  const patch = settingsPatch(settings({ schedule: "recurring", recurrenceMonths: null }));
  assert.equal(patch.ok, true);
  const draft = emptyDraft({ title: "Ramp" });
  const saved = applyDraftOps(draft, [{ op: "setMeta", meta: (patch as { ok: true; meta: object }).meta }]);
  assert.equal(saved.ok, true);
  const problems = publishProblems((saved as { ok: true; doc: typeof draft }).doc).map((p) => p.problem);
  assert.ok(problems.includes("A recurring course needs the number of months between renewals."), problems.join("; "));
  assert.equal(scheduleChoice(null), "none");
  assert.equal(scheduleChoice("annual"), "annual");
});

test("removing a package block says it can only come back by discarding the draft", () => {
  const prompt = removeBlockPrompt({ kind: "package", key: "p1", launchableId: "dddddddd-0000-0000-0000-000000000001", title: "Dangerous goods", standard: "scorm12" });
  assert.match(prompt, /"Dangerous goods"/);
  assert.match(prompt, /discard this draft/);
  assert.equal(removeBlockPrompt({ kind: "roleplay", key: "r1", persona: "", scenario: "", rubricMd: "" }), "Remove this role-play block?");
});

test("a version's counts read naturally", () => {
  assert.equal(versionCounts({ lessonCount: 1, blockCount: 0, enrollmentCount: 0 }), "1 lesson · 0 blocks · 0 enrolled");
  assert.equal(versionCounts({ lessonCount: 3, blockCount: 1, enrollmentCount: 12 }), "3 lessons · 1 block · 12 enrolled");
});
