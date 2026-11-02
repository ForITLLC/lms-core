import { callTool } from "@/lib/ai/authoring/util";
import { MODELS } from "@/lib/ai/claude";
import { GeneratedBatch, REASONING_CATEGORIES, type GeneratedItem } from "@/lib/drill/schema";

export const BATCH_SIZE = 10;

const SYSTEM = `You write daily reasoning drills for working professionals — the kind of
short, self-contained questions found on the GMAT. The point is to keep people's own
reasoning sharp in an era of AI assistance, so every item must be solvable in the head or
with a quick pencil calculation, never by recall of trivia.

Categories (mix them evenly across a batch):
- critical-reasoning: a 3–5 sentence argument, then ask for the assumption, what most
  strengthens or weakens it, or what can properly be inferred. Five choices.
- data-sufficiency: a question plus statements (1) and (2). Choices are always exactly:
  a "Statement (1) alone is sufficient, but (2) alone is not", b "Statement (2) alone is
  sufficient, but (1) alone is not", c "Both together are sufficient, but neither alone",
  d "Each statement alone is sufficient", e "Neither, even together, is sufficient".
- quantitative: arithmetic, percentages, rates, ratios, simple algebra, counting or
  probability. Numbers must be calculator-free. Five choices.
- reading-comprehension: an 80–120 word passage on business, operations, science or
  everyday topics, then one inference or main-point question. Four or five choices.
- logic: ordering, grouping, conditional or set puzzles with a single forced answer. Four
  or five choices.

Rules: workplace-neutral contexts (no politics, religion, medical or legal advice);
exactly one unambiguous correct choice; distractors must be plausible; no "all of the
above"; never hint at the answer in the prompt; difficulty 2–4 on a 1–5 scale; prompts and
explanations in Markdown (use $-free plain notation, e.g. 3/4 or 25%); explanationMd is
2–5 sentences that teaches the reasoning path, not just the answer. Choice ids are lowercase
letters a, b, c, d, e in order. Do not reuse or lightly reword any prompt in the
already-used list.`;

const INPUT_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      minItems: 1,
      maxItems: BATCH_SIZE,
      items: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["mcq"] },
          category: { type: "string", enum: [...REASONING_CATEGORIES] },
          difficulty: { type: "integer", minimum: 1, maximum: 5 },
          promptMd: { type: "string" },
          choices: {
            type: "array",
            minItems: 4,
            maxItems: 5,
            items: {
              type: "object",
              properties: { id: { type: "string" }, label: { type: "string" } },
              required: ["id", "label"],
            },
          },
          correctChoiceId: { type: "string" },
          explanationMd: { type: "string" },
        },
        required: [
          "kind",
          "category",
          "difficulty",
          "promptMd",
          "choices",
          "correctChoiceId",
          "explanationMd",
        ],
      },
    },
  },
  required: ["items"],
} as const;

function wellFormed(item: GeneratedItem): boolean {
  const ids = item.choices.map((c) => c.id);
  return new Set(ids).size === ids.length && ids.includes(item.correctChoiceId);
}

export async function generateBatch(count: number, alreadyUsed: string[]): Promise<GeneratedItem[]> {
  const n = Math.max(1, Math.min(BATCH_SIZE, count));
  const used = alreadyUsed.length
    ? `Already-used prompts (do not repeat):\n${alreadyUsed.map((p) => `- ${p.slice(0, 160)}`).join("\n")}`
    : "No prompts have been used yet.";
  const { input: raw } = await callTool({
    model: MODELS.bulk,
    maxTokens: 8000,
    cachedSystem: SYSTEM,
    userMessage: `Write ${n} new items, spread across the categories. ${used}`,
    toolName: "submit_drill_items",
    toolDescription: "Submit the batch of generated reasoning drill items.",
    inputSchema: INPUT_SCHEMA as unknown as Parameters<typeof callTool>[0]["inputSchema"],
  });
  const parsed = GeneratedBatch.safeParse(raw);
  if (!parsed.success) throw new Error(`Generated batch failed validation: ${parsed.error.message}`);
  return parsed.data.items.filter(wellFormed);
}
