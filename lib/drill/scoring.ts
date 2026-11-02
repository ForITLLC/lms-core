import { Rating, type Grade } from "ts-fsrs";
import type { QuizQuestion } from "@/lib/schema/quiz";

export type Confidence = 1 | 2 | 3;

export const EASY_MS = 10_000;
export const SLOW_MS = 30_000;

export const POINTS_CORRECT = 10;
export const POINTS_CERTAIN_BONUS = 5;
export const POINTS_CERTAIN_WRONG = -5;
export const POINTS_COMPLETION = 10;
export const STREAK_BONUS_CAP = 10;

export function ratingFor(correct: boolean, confidence: Confidence, responseMs: number): Grade {
  if (!correct) return Rating.Again;
  if (confidence === 1 || responseMs > SLOW_MS) return Rating.Hard;
  if (confidence === 3 && responseMs < EASY_MS) return Rating.Easy;
  return Rating.Good;
}

export function pointsFor(correct: boolean, confidence: Confidence): number {
  if (correct) return POINTS_CORRECT + (confidence === 3 ? POINTS_CERTAIN_BONUS : 0);
  return confidence === 3 ? POINTS_CERTAIN_WRONG : 0;
}

export function completionBonus(streak: number): number {
  return POINTS_COMPLETION + Math.min(Math.max(streak, 0), STREAK_BONUS_CAP);
}

export function isCorrect(question: QuizQuestion, response: unknown): boolean {
  switch (question.kind) {
    case "mcq":
    case "confidence":
      return typeof response === "string" && response === question.correctChoiceId;
    case "tf":
      return typeof response === "boolean" && response === question.correctValue;
    case "multi": {
      if (!Array.isArray(response)) return false;
      const got = new Set(response.filter((x): x is string => typeof x === "string"));
      const want = new Set(question.correctChoiceIds);
      return got.size === want.size && [...want].every((id) => got.has(id));
    }
    case "short":
      return false;
  }
}
