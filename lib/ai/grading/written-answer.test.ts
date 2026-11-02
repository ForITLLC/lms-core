import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewText, statusText, verdictText } from "@/lib/ai/grading/written-answer";

// What a learner reads about a written answer's mark (slice A5b): pass or fail
// from the deciding score alone, and each status in words that say who marked it.

test("the verdict follows the deciding score, never the provisional one that counts the AI's marks", () => {
  const waiting = verdictText({ score: 40, provisionalScore: 90, passingScore: 70, waiting: true });
  assert.match(waiting, /score: 40%\. The pass mark is 70%\./);
  assert.match(waiting, /may change/);
  assert.equal(waiting.includes("90"), false);
  assert.equal(waiting.includes("Passed"), false);

  assert.equal(verdictText({ score: 70, provisionalScore: 70, passingScore: 70, waiting: false }), "Knowledge check score: 70%. Passed.");
  assert.equal(verdictText({ score: 69, passingScore: 70, waiting: false }), "Knowledge check score: 69%. The pass mark is 70%.");
  assert.match(verdictText({ score: 100, provisionalScore: 100, passingScore: 70, waiting: true }), /Passed\. Some written answers haven't been marked/);
});

test("each status says who marked the answer, and an AI mark says it is provisional", () => {
  const mark = { score: 3, maxScore: 5 };
  assert.equal(statusText({ ...mark, status: "awaiting_instructor" }), "Waiting for your instructor");
  assert.equal(statusText({ ...mark, status: "ai_provisional" }), "Provisional mark 3/5 (marked by AI; your instructor will confirm it)");
  assert.equal(statusText({ ...mark, status: "instructor_confirmed" }), "Mark 3/5, confirmed by your instructor");
  assert.equal(statusText({ ...mark, status: "instructor_marked" }), "Mark 3/5 from your instructor");
  assert.equal(statusText({ score: null, maxScore: null, status: "awaiting_instructor" }), "Waiting for your instructor");
});

test("a review request reads as asked, then answered, and says nothing when there was none", () => {
  assert.equal(reviewText("none"), null);
  assert.equal(reviewText("open"), "You asked your instructor to look at this again.");
  assert.equal(reviewText("answered"), "Your instructor looked at this again.");
});
