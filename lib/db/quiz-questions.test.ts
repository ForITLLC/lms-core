import { test } from "node:test";
import assert from "node:assert/strict";
import { groupQuizQuestions, questionsForQuiz } from "./quiz-questions";

const tf = (promptMd: string) => JSON.stringify({ kind: "tf", promptMd, correctValue: true });

test("an upper-case QuizId from SQL matches the lower-case quizId in the block payload", () => {
  const byQuiz = groupQuizQuestions([
    { QuizId: "0B000003-0000-4000-8000-00000000000A", PayloadJson: tf("first") },
    { QuizId: "0B000003-0000-4000-8000-00000000000A", PayloadJson: tf("second") },
  ]);
  const questions = questionsForQuiz(byQuiz, "0b000003-0000-4000-8000-00000000000a");
  assert.deepEqual(
    questions.map((q) => q.promptMd),
    ["first", "second"],
  );
});

test("a question that fails the schema is dropped, the rest kept in order", () => {
  const byQuiz = groupQuizQuestions([
    { QuizId: "A", PayloadJson: JSON.stringify({ kind: "nope" }) },
    { QuizId: "A", PayloadJson: tf("kept") },
  ]);
  assert.deepEqual(questionsForQuiz(byQuiz, "a").map((q) => q.promptMd), ["kept"]);
});

test("a quiz with no rows has no questions", () => {
  assert.deepEqual(questionsForQuiz(groupQuizQuestions([]), "b"), []);
});
