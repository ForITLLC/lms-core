import { z } from "zod";
import { Mcq } from "@/lib/schema/quiz";

export const REASONING_CATEGORIES = [
  "critical-reasoning",
  "data-sufficiency",
  "quantitative",
  "reading-comprehension",
  "logic",
] as const;
export type ReasoningCategory = (typeof REASONING_CATEGORIES)[number];

export const ReasoningPayload = Mcq.extend({ explanationMd: z.string().min(1) });
export type ReasoningPayload = z.infer<typeof ReasoningPayload>;

export const GeneratedItem = ReasoningPayload.extend({
  category: z.enum(REASONING_CATEGORIES),
  difficulty: z.number().int().min(1).max(5),
});
export type GeneratedItem = z.infer<typeof GeneratedItem>;

export const GeneratedBatch = z.object({ items: z.array(GeneratedItem).min(1).max(10) });

export const ConfidenceSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

export const AnswerBody = z.object({
  sessionId: z.string().uuid(),
  slot: z.number().int().min(0).max(9),
  response: z.union([z.string().max(64), z.boolean(), z.array(z.string().max(64)).max(16)]),
  confidence: ConfidenceSchema,
  responseMs: z.number().int().min(0).max(3_600_000),
});
export type AnswerBody = z.infer<typeof AnswerBody>;
