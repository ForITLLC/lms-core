import { z } from "zod";
import { MODELS } from "@/lib/ai/claude";
import { callTool } from "./util";
import { ModelOutputError, type CallUsage } from "./usage";
import { material, sourceCorpus, type SourceExtract } from "./source";

export const LessonOutline = z.object({
  title: z.string().min(1).max(200),
  summary: z.string().min(1),
  objectives: z.array(z.string().min(1)).min(1).max(5),
  estMinutes: z.number().int().positive().max(120),
});

export const CourseOutline = z.object({
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[a-z0-9-]+$/, "slug must be kebab-case ASCII"),
  description: z.string().min(1),
  lessons: z.array(LessonOutline).min(3).max(10),
});

export type CourseOutline = z.infer<typeof CourseOutline>;
export type LessonOutline = z.infer<typeof LessonOutline>;

export interface OutlineOptions {
  lessonCount?: number | null;
}

// With no lesson count asked for, the prompt is byte for byte what it was
// before A4, so its cached system prompt is unchanged.
const system = (source: SourceExtract, lessonCount: number | null) => `You are an instructional designer who turns long-form source material into structured e-learning courses.

Produce a course outline from the source ${material(source)}. The course should teach the concepts in the source, broken into ${lessonCount ?? "4-8"} focused lessons that build on each other. Each lesson should be a self-contained learning unit (10-25 minutes of study).

Rules:
- The course title and slug must reflect the ACTUAL content (not generic placeholders like "Course 1").
- Lessons must flow in pedagogical order: foundation → application → synthesis.
- Each lesson needs 1-5 measurable learning objectives that start with a verb.
- Do not invent content not present in the source. If the source is short, produce fewer lessons (minimum 3).
- Slug must be kebab-case ASCII (letters, digits, hyphens), no leading/trailing hyphen.

You MUST call the submit_outline tool with the course outline. Do not respond with prose.`;

const inputSchema = (minLessons: number, maxLessons: number) => ({
  type: "object" as const,
  properties: {
    title: { type: "string", minLength: 1, maxLength: 200 },
    slug: { type: "string", pattern: "^[a-z0-9][a-z0-9-]*[a-z0-9]$", minLength: 3, maxLength: 80 },
    description: { type: "string", minLength: 1 },
    lessons: {
      type: "array",
      minItems: minLessons,
      maxItems: maxLessons,
      items: {
        type: "object",
        properties: {
          title: { type: "string", minLength: 1, maxLength: 200 },
          summary: { type: "string", minLength: 1 },
          objectives: {
            type: "array",
            minItems: 1,
            maxItems: 5,
            items: { type: "string", minLength: 1 },
          },
          estMinutes: { type: "integer", minimum: 5, maximum: 60 },
        },
        required: ["title", "summary", "objectives", "estMinutes"],
      },
    },
  },
  required: ["title", "slug", "description", "lessons"],
});

export async function generateOutline(
  extract: SourceExtract,
  options: OutlineOptions = {},
): Promise<CourseOutline & { usage: CallUsage }> {
  const corpus = sourceCorpus(extract, true);
  const lessonCount = options.lessonCount ?? null;

  const { input, usage } = await callTool({
    model: MODELS.bulk,
    maxTokens: 4096,
    cachedSystem: `${system(extract, lessonCount)}\n\n--- SOURCE CORPUS ---\n${corpus}`,
    userMessage: "Produce the course outline for the source above and submit it via the submit_outline tool.",
    toolName: "submit_outline",
    toolDescription: "Submit the complete course outline including all lessons.",
    inputSchema: inputSchema(lessonCount ?? 3, lessonCount ?? 10),
  });

  const parsed = CourseOutline.safeParse(input);
  if (!parsed.success) {
    throw new ModelOutputError(`Outline did not match schema after tool_use: ${parsed.error.message}`, usage);
  }
  return { ...parsed.data, usage };
}
