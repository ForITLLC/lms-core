import { test } from "node:test";
import assert from "node:assert/strict";
import { Rating } from "ts-fsrs";
import { ratingFor, pointsFor, completionBonus } from "./scoring";

test("wrong answers are Again regardless of confidence or speed", () => {
  assert.equal(ratingFor(false, 3, 1_000), Rating.Again);
  assert.equal(ratingFor(false, 1, 60_000), Rating.Again);
});

test("correct but guessed or slow is Hard", () => {
  assert.equal(ratingFor(true, 1, 5_000), Rating.Hard);
  assert.equal(ratingFor(true, 2, 30_001), Rating.Hard);
  assert.equal(ratingFor(true, 3, 30_001), Rating.Hard);
});

test("correct and fairly sure is Good; certain but not fast is Good", () => {
  assert.equal(ratingFor(true, 2, 5_000), Rating.Good);
  assert.equal(ratingFor(true, 3, 10_000), Rating.Good);
  assert.equal(ratingFor(true, 3, 29_999), Rating.Good);
});

test("correct, certain and under ten seconds is Easy", () => {
  assert.equal(ratingFor(true, 3, 9_999), Rating.Easy);
});

test("points reward correctness and punish overconfidence only", () => {
  assert.equal(pointsFor(true, 1), 10);
  assert.equal(pointsFor(true, 2), 10);
  assert.equal(pointsFor(true, 3), 15);
  assert.equal(pointsFor(false, 1), 0);
  assert.equal(pointsFor(false, 2), 0);
  assert.equal(pointsFor(false, 3), -5);
});

test("completion bonus is 10 plus the streak, capped at 10 extra", () => {
  assert.equal(completionBonus(1), 11);
  assert.equal(completionBonus(10), 20);
  assert.equal(completionBonus(45), 20);
});

test("isCorrect grades mcq, confidence, tf and multi; short is never auto-correct", () => {
  const { isCorrect } = require("./scoring") as typeof import("./scoring");
  const choices = [{ id: "a", label: "A" }, { id: "b", label: "B" }];
  assert.equal(isCorrect({ kind: "mcq", promptMd: "", choices, correctChoiceId: "b" }, "b"), true);
  assert.equal(isCorrect({ kind: "mcq", promptMd: "", choices, correctChoiceId: "b" }, "a"), false);
  assert.equal(isCorrect({ kind: "confidence", promptMd: "", choices, correctChoiceId: "a" }, "a"), true);
  assert.equal(isCorrect({ kind: "tf", promptMd: "", correctValue: false }, false), true);
  assert.equal(isCorrect({ kind: "tf", promptMd: "", correctValue: false }, "false"), false);
  assert.equal(isCorrect({ kind: "multi", promptMd: "", choices, correctChoiceIds: ["a", "b"] }, ["b", "a"]), true);
  assert.equal(isCorrect({ kind: "multi", promptMd: "", choices, correctChoiceIds: ["a", "b"] }, ["a"]), false);
  assert.equal(isCorrect({ kind: "short", promptMd: "", rubricMd: "", maxScore: 5 }, "anything"), false);
});
