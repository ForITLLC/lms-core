import type { QuizQuestion } from "@/lib/schema/quiz";
import type { Reveal } from "./choice-state";

export { choiceState, type ChoiceState, type Reveal } from "./choice-state";

type Choice = { id: string; label: string };

export type PublicQuestion =
  | { kind: "mcq" | "confidence" | "multi"; promptMd: string; choices: Choice[] }
  | { kind: "tf" | "short"; promptMd: string };

/** The learner-facing shape: prompt and choices only. Never includes an answer key. */
export function toPublicQuestion(q: QuizQuestion): PublicQuestion {
  switch (q.kind) {
    case "mcq":
    case "confidence":
    case "multi":
      return { kind: q.kind, promptMd: q.promptMd, choices: q.choices };
    case "tf":
    case "short":
      return { kind: q.kind, promptMd: q.promptMd };
  }
}

export function revealFor(q: QuizQuestion): Reveal {
  switch (q.kind) {
    case "mcq":
    case "confidence":
      return { kind: q.kind, correct: q.correctChoiceId };
    case "multi":
      return { kind: "multi", correct: q.correctChoiceIds };
    case "tf":
      return { kind: "tf", correct: q.correctValue };
    case "short":
      return { kind: "short", correct: null };
  }
}
