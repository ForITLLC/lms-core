import { z } from "zod";

export const Mcq = z.object({
  kind: z.literal("mcq"),
  promptMd: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
  correctChoiceId: z.string(),
});

export const Multi = z.object({
  kind: z.literal("multi"),
  promptMd: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
  correctChoiceIds: z.array(z.string()).min(1),
});

export const TrueFalse = z.object({
  kind: z.literal("tf"),
  promptMd: z.string(),
  correctValue: z.boolean(),
});

export const ShortAnswer = z.object({
  kind: z.literal("short"),
  promptMd: z.string(),
  rubricMd: z.string(),
  maxScore: z.number().int().positive().default(5),
});

export const ConfidenceMcq = z.object({
  kind: z.literal("confidence"),
  promptMd: z.string(),
  choices: z.array(z.object({ id: z.string(), label: z.string() })).min(2),
  correctChoiceId: z.string(),
});

export const QuizQuestion = z.discriminatedUnion("kind", [
  Mcq,
  Multi,
  TrueFalse,
  ShortAnswer,
  ConfidenceMcq,
]);

export type QuizQuestion = z.infer<typeof QuizQuestion>;
export type QuizQuestionKind = QuizQuestion["kind"];
