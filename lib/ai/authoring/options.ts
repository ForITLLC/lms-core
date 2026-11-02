import { z } from "zod";

// What an author may ask of an AI authoring job besides its source
// (docs/plans/2026-10-29-ai-authoring.md, slice A4). They ride in the job's
// OptionsJson and reach the prompts: the lesson count shapes the outline, and
// with quizzes off no quiz call is made at all. This file imports only zod, so
// the author form reads the same bounds.

// The outline schema's own bounds (lib/ai/authoring/outline.ts).
export const LESSON_COUNT_MIN = 3;
export const LESSON_COUNT_MAX = 10;

export const AuthoringOptions = z
  .object({
    lessonCount: z.number().int().min(LESSON_COUNT_MIN).max(LESSON_COUNT_MAX).optional(),
    quizzes: z.boolean().optional(),
  })
  .strict();

export type AuthoringOptions = z.infer<typeof AuthoringOptions>;

export interface JobOptions {
  lessonCount: number | null;
  quizzes: boolean;
}

// A job queued before A4, or by the CLI, holds no options and gets what every
// job got before: the model picks the lesson count and every lesson a quiz.
export function readJobOptions(optionsJson: string | null): JobOptions {
  let raw: unknown;
  try {
    raw = JSON.parse(optionsJson ?? "null");
  } catch {
    raw = null;
  }
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const lessonCount = AuthoringOptions.shape.lessonCount.safeParse(record.lessonCount);
  return {
    lessonCount: lessonCount.success && lessonCount.data !== undefined ? lessonCount.data : null,
    quizzes: record.quizzes !== false,
  };
}
