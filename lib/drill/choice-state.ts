// Kept apart from public.ts so the drill player's browser code never carries
// revealFor, which reads the answer key (components/blocks/no-client-grading.test.ts).

export type Reveal =
  | { kind: "mcq" | "confidence"; correct: string }
  | { kind: "multi"; correct: string[] }
  | { kind: "tf"; correct: boolean }
  | { kind: "short"; correct: null };

export type ChoiceState = "correct" | "wrong" | "missed" | "neutral";

/**
 * How one choice should render once the answer is revealed: the learner's
 * pick that was right, their pick that was wrong, a right answer they did
 * not pick, or nothing of note.
 */
export function choiceState(
  reveal: Reveal,
  chosen: string | string[] | boolean | null,
  choiceId: string,
): ChoiceState {
  const correctIds =
    reveal.kind === "multi"
      ? reveal.correct
      : reveal.kind === "short"
        ? []
        : [String(reveal.correct)];
  if (correctIds.length === 0) return "neutral";
  const picked = Array.isArray(chosen) ? chosen.includes(choiceId) : String(chosen) === choiceId;
  const isCorrect = correctIds.includes(choiceId);
  if (picked && isCorrect) return "correct";
  if (picked) return "wrong";
  if (isCorrect) return "missed";
  return "neutral";
}
