import { z } from "zod";
import { MODELS } from "@/lib/ai/claude";
import { QuizQuestion } from "@/lib/schema/quiz";
import { callTool } from "./util";
import { ModelOutputError, type CallUsage } from "./usage";
import type { LessonOutline } from "./outline";
import { sourceCorpus, type SourceExtract } from "./source";

const QuizResponse = z.object({
  questions: z.array(QuizQuestion).min(3).max(6),
});

export type LessonQuiz = z.infer<typeof QuizResponse>;

const SYSTEM = `You are an assessment author. For one lesson, produce 3-5 quiz questions that check whether a learner met the lesson's learning objectives.

Question kinds available:
- "mcq" — single-correct multiple choice. 3-5 choices, ids must be lowercase letters "a","b","c","d","e". correctChoiceId must match one of the ids.
- "tf" — true/false. correctValue is boolean.
- "short" — short answer. Must include rubricMd describing what a full-credit answer contains.

Rules:
- Favor mcq for factual recall, tf for testing common misconceptions, short for application/synthesis.
- Each lesson should have at least 2 mcq, at most 1 short.
- Anchor every question to a learning objective. Do not test trivia outside the lesson scope.
- Choice labels must be plausible distractors — not obviously wrong.

You MUST call the submit_quiz tool with the questions.`;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    questions: {
      type: "array",
      minItems: 3,
      maxItems: 6,
      items: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "mcq" },
              promptMd: { type: "string", minLength: 1 },
              choices: {
                type: "array",
                minItems: 3,
                maxItems: 5,
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string", pattern: "^[a-e]$" },
                    label: { type: "string", minLength: 1 },
                  },
                  required: ["id", "label"],
                },
              },
              correctChoiceId: { type: "string", pattern: "^[a-e]$" },
            },
            required: ["kind", "promptMd", "choices", "correctChoiceId"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "tf" },
              promptMd: { type: "string", minLength: 1 },
              correctValue: { type: "boolean" },
            },
            required: ["kind", "promptMd", "correctValue"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "short" },
              promptMd: { type: "string", minLength: 1 },
              rubricMd: { type: "string", minLength: 1 },
              maxScore: { type: "integer", minimum: 1, maximum: 10 },
            },
            required: ["kind", "promptMd", "rubricMd"],
          },
        ],
      },
    },
  },
  required: ["questions"],
};

export async function generateQuiz(args: {
  extract: SourceExtract;
  courseTitle: string;
  lesson: LessonOutline;
  lessonIndex: number;
}): Promise<LessonQuiz & { usage: CallUsage }> {
  const { extract, courseTitle, lesson, lessonIndex } = args;

  const corpus = sourceCorpus(extract, false);

  const userMsg = [
    `Course: ${courseTitle}`,
    `Lesson ${lessonIndex + 1}: ${lesson.title}`,
    `Summary: ${lesson.summary}`,
    `Learning objectives:`,
    ...lesson.objectives.map((o) => `  - ${o}`),
    "",
    "Submit 3-5 quiz questions for this lesson via the submit_quiz tool.",
  ].join("\n");

  const { input, usage } = await callTool({
    model: MODELS.bulk,
    maxTokens: 4096,
    cachedSystem: `${SYSTEM}\n\n--- SOURCE CORPUS ---\n${corpus}`,
    userMessage: userMsg,
    toolName: "submit_quiz",
    toolDescription: "Submit the quiz questions for this lesson.",
    inputSchema: INPUT_SCHEMA,
  });

  const parsed = QuizResponse.safeParse(input);
  if (!parsed.success) {
    throw new ModelOutputError(`Quiz did not match schema after tool_use for lesson ${lessonIndex + 1}: ${parsed.error.message}`, usage);
  }
  return { ...parsed.data, usage };
}
