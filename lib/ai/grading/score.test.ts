import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as quizSchema from "@/lib/schema/quiz";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";

// An attempt's score once its written answers have marks (slice A5a). Q3: an
// AI mark is provisional, so only the automatically marked questions and the
// instructor's marks move the pass/fail score; the AI's show only in the
// provisional score. The real policy.ts is loaded, so flipping that rule
// fails here.

const policy = vmLoad(new URL("./policy.ts", import.meta.url), { "@/lib/ai/authoring/limits": {}, "@/lib/db/ai-settings": {} });
const score = vmLoad(new URL("./score.ts", import.meta.url), { "./policy": policy });
const quizzes = vmLoad(new URL("../../db/quizzes.ts", import.meta.url), {
  "node:crypto": crypto, "@/lib/db": {}, "@/lib/db/course-scope": {}, "@/lib/schema/quiz": quizSchema,
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const MCQ = { kind: "mcq", promptMd: "Pick one", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "a" } as const;
const TF = { kind: "tf", promptMd: "True?", correctValue: true } as const;
const SHORT = { kind: "short", promptMd: "Explain lift.", rubricMd: "Mentions pressure difference.", maxScore: 5 } as const;

let n = 0;
function grade(questionId: string, seq: number, source: "ai" | "instructor", points: number, extra: Record<string, unknown> = {}) {
  return {
    gradeId: `g-${++n}`, questionId, seq, source, score: points, maxScore: 5, feedbackMd: null,
    model: source === "ai" ? "claude-sonnet-4-6" : null, promptVersion: source === "ai" ? "short-answer-1" : null,
    gradedBy: source === "instructor" ? "instructor@example.test" : null, gradedAt: new Date(0), reason: null, confirmsGradeId: null, ...extra,
  };
}

test("Q3 as built: an AI mark doesn't decide pass or fail, an instructor's does", () => {
  assert.equal(policy.AI_MARKS_DECIDE_PASS, false);
  assert.equal(policy.markDecidesPass("ai"), false);
  assert.equal(policy.markDecidesPass("instructor"), true);
});

test("with no marks the score is exactly what gradeResponses recorded, for every mix of answers", () => {
  const questions = [MCQ, TF, SHORT, MCQ].map((question, orderIndex) => ({ questionId: `q${orderIndex}`, orderIndex, question }));
  for (const responses of [["a", true, "x", "a"], ["b", true, "x", "b"], ["b", false, "", "b"], [null, null, null, null], ["a", true, "x", "b"]]) {
    const recorded = quizzes.gradeResponses(questions, responses);
    const answers = recorded.perQuestion.map((p: any) => ({ questionId: p.questionId, orderIndex: p.orderIndex, machineScore: p.correct === null ? null : p.correct ? 1 : 0 }));
    const scored = score.scoreAttempt(answers, []);
    assert.equal(scored.score, recorded.score, JSON.stringify(responses));
    assert.equal(scored.provisionalScore, recorded.score);
    assert.equal(scored.answers[2].status, "awaiting_instructor");
  }
});

test("an AI mark moves only the provisional score; an instructor's confirmation makes it count", () => {
  const answers = [{ questionId: "q0", orderIndex: 0, machineScore: 0 }, { questionId: "Q1", orderIndex: 1, machineScore: null }];
  const ai = grade("q1", 1, "ai", 5);
  const provisional = score.scoreAttempt(answers, [ai]);
  assert.equal(provisional.score, 0, "the wrong MCQ alone decides");
  assert.equal(provisional.provisionalScore, 50);
  assert.deepEqual(plain(provisional.answers[1]), {
    questionId: "Q1", orderIndex: 1, status: "ai_provisional", score: 5, maxScore: 5, gradeId: ai.gradeId, feedbackMd: null, decidesPass: false,
  });

  const confirmed = score.scoreAttempt(answers, [ai, grade("q1", 2, "instructor", 5, { confirmsGradeId: ai.gradeId })]);
  assert.equal(confirmed.score, 50);
  assert.equal(confirmed.answers[1].status, "instructor_confirmed");
  assert.equal(confirmed.answers[1].decidesPass, true);
});

test("a short-answer-only quiz never passes on AI marks, however high", () => {
  const answers = [{ questionId: "s0", orderIndex: 0, machineScore: null }, { questionId: "s1", orderIndex: 1, machineScore: null }];
  const ai = score.scoreAttempt(answers, [grade("s0", 1, "ai", 5), grade("s1", 2, "ai", 5)]);
  assert.equal(ai.score, 0);
  assert.equal(ai.provisionalScore, 100);
  const one = score.scoreAttempt(answers, [grade("s0", 1, "ai", 5), grade("s1", 2, "ai", 5), grade("s0", 3, "instructor", 4, { reason: "Close" })]);
  assert.equal(one.score, 80, "only the instructor's 4 of 5 counts");
  assert.equal(one.provisionalScore, 90);
});

test("the latest instructor mark stands, even over a later AI mark; each question weighs the same", () => {
  const answers = [{ questionId: "q0", orderIndex: 0, machineScore: 1 }, { questionId: "q1", orderIndex: 1, machineScore: null }];
  const grades = [
    grade("q1", 1, "ai", 5),
    grade("q1", 2, "instructor", 1, { reason: "Missed the point" }),
    grade("q1", 3, "instructor", 3, { reason: "On second reading" }),
    grade("q1", 4, "ai", 5),
  ];
  const standing = score.standingGrade(grades, "Q1");
  assert.equal(standing.seq, 3);
  const scored = score.scoreAttempt(answers, grades);
  assert.equal(scored.answers[1].status, "instructor_marked");
  assert.equal(scored.score, 80, "1 + 3/5 over two questions");
  assert.equal(score.standingGrade(grades, "q9"), null);
});
