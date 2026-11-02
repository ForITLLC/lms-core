import { test } from "node:test";
import assert from "node:assert/strict";
import { toPublicQuestion, revealFor, choiceState } from "./public";
import type { QuizQuestion } from "@/lib/schema/quiz";

const mcq: QuizQuestion = {
  kind: "mcq",
  promptMd: "2+2?",
  choices: [{ id: "a", label: "3" }, { id: "b", label: "4" }],
  correctChoiceId: "b",
};
const multi: QuizQuestion = {
  kind: "multi",
  promptMd: "evens?",
  choices: [{ id: "a", label: "1" }, { id: "b", label: "2" }, { id: "c", label: "4" }],
  correctChoiceIds: ["b", "c"],
};
const tf: QuizQuestion = { kind: "tf", promptMd: "sky is blue", correctValue: true };

test("public questions carry no answer key", () => {
  for (const q of [mcq, multi, tf]) {
    const pub = JSON.stringify(toPublicQuestion(q));
    assert.ok(!pub.includes("correctChoiceId"));
    assert.ok(!pub.includes("correctChoiceIds"));
    assert.ok(!pub.includes("correctValue"));
    assert.ok(!pub.includes("rubricMd"));
  }
  assert.deepEqual(toPublicQuestion(mcq), { kind: "mcq", promptMd: "2+2?", choices: mcq.choices });
  assert.deepEqual(toPublicQuestion(tf), { kind: "tf", promptMd: "sky is blue" });
});

test("revealFor returns the key in the response shape", () => {
  assert.deepEqual(revealFor(mcq), { kind: "mcq", correct: "b" });
  assert.deepEqual(revealFor(multi), { kind: "multi", correct: ["b", "c"] });
  assert.deepEqual(revealFor(tf), { kind: "tf", correct: true });
});

test("choiceState colours a choice after the answer is revealed", () => {
  const r = revealFor(mcq);
  assert.equal(choiceState(r, "b", "b"), "correct");
  assert.equal(choiceState(r, "a", "a"), "wrong");
  assert.equal(choiceState(r, "a", "b"), "missed");
  assert.equal(choiceState(r, "b", "a"), "neutral");
  const m = revealFor(multi);
  assert.equal(choiceState(m, ["b"], "b"), "correct");
  assert.equal(choiceState(m, ["b"], "c"), "missed");
  assert.equal(choiceState(m, ["a", "b"], "a"), "wrong");
  assert.equal(choiceState(m, ["b", "c"], "a"), "neutral");
  const t = revealFor(tf);
  assert.equal(choiceState(t, true, "true"), "correct");
  assert.equal(choiceState(t, false, "false"), "wrong");
  assert.equal(choiceState(t, false, "true"), "missed");
  assert.equal(choiceState(t, null, "false"), "neutral");
  assert.equal(choiceState({ kind: "short", correct: null }, "x", "x"), "neutral");
});
