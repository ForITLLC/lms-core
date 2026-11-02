import { z } from "zod";
import { MODELS } from "@/lib/ai/claude";
import {
  TextBlock,
  ImageBlock,
  VideoBlock,
  EmbedBlock,
  CalloutBlock,
} from "@/lib/schema/blocks";
import { callTool } from "./util";
import { ModelOutputError, type CallUsage } from "./usage";
import type { LessonOutline } from "./outline";
import { isVideo, material, sourceCorpus, type SourceExtract } from "./source";

const AuthorableBlock = z.discriminatedUnion("kind", [
  TextBlock,
  ImageBlock,
  VideoBlock,
  EmbedBlock,
  CalloutBlock,
]);

export type AuthorableBlock = z.infer<typeof AuthorableBlock>;

// A block the model produced that the block schemas refuse, such as an image
// at a non-http(s) address. Positions are 1-based, as the author counts them.
export interface DroppedBlock {
  lesson: number;
  position: number;
  kind: string;
  reason: string;
}

export interface LessonBlocks {
  blocks: AuthorableBlock[];
  dropped: DroppedBlock[];
  usage: CallUsage;
}

// Only a video source is embedded, once, in lesson 1.
const system = (source: SourceExtract) => `You are an instructional designer authoring the body of a single lesson inside a larger course.

Produce an ordered list of content BLOCKS that teach the lesson. Use the source ${material(source)} as the factual basis — do not invent facts not present in the source.

Allowed block kinds: "text", "callout", "embed", "image", "video". No other kinds exist.

Rules:
- 4-8 blocks per lesson.
- ALWAYS start with a "text" block: a 2-3 sentence intro that names the lesson topic and what the learner will learn.
- Use "text" blocks for the main content (markdown — including fenced code blocks like \`\`\`bash ... \`\`\` for shell/code samples). Aim for substantive explanation — 100-400 words per text block.
- Use 1-2 "callout" blocks per lesson for key concepts, warnings, or pro tips. Variants: "info", "warning", "success", "tip".${isVideo(source) ? `
- Embed the source video EXACTLY ONCE as an "embed" block with provider:"youtube" near the top of the FIRST lesson only (you'll be told if this is lesson 1).` : ""}
- Do NOT include quiz blocks — those are generated separately.

You MUST call the submit_blocks tool with the blocks for this lesson.`;

const INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    blocks: {
      type: "array",
      minItems: 2,
      maxItems: 12,
      items: {
        type: "object",
        oneOf: [
          {
            type: "object",
            properties: {
              kind: { const: "text" },
              markdown: { type: "string", minLength: 1 },
            },
            required: ["kind", "markdown"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "callout" },
              variant: { enum: ["info", "warning", "success", "tip"] },
              markdown: { type: "string", minLength: 1 },
            },
            required: ["kind", "variant", "markdown"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "embed" },
              url: { type: "string", format: "uri" },
              provider: { enum: ["youtube", "vimeo", "loom", "other"] },
            },
            required: ["kind", "url", "provider"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "image" },
              url: { type: "string", format: "uri" },
              alt: { type: "string" },
              caption: { type: "string" },
            },
            required: ["kind", "url"],
          },
          {
            type: "object",
            properties: {
              kind: { const: "video" },
              url: { type: "string", format: "uri" },
              transcript: { type: "string" },
            },
            required: ["kind", "url"],
          },
        ],
      },
    },
  },
  required: ["blocks"],
};

export async function generateBlocks(args: {
  extract: SourceExtract;
  courseTitle: string;
  lesson: LessonOutline;
  lessonIndex: number;
  totalLessons: number;
}): Promise<LessonBlocks> {
  const { extract, courseTitle, lesson, lessonIndex, totalLessons } = args;

  const corpus = sourceCorpus(extract, true);

  const userMsg = [
    `Course: ${courseTitle}`,
    `Lesson ${lessonIndex + 1} of ${totalLessons}: ${lesson.title}`,
    `Summary: ${lesson.summary}`,
    `Learning objectives:`,
    ...lesson.objectives.map((o) => `  - ${o}`),
    `Estimated time: ${lesson.estMinutes} minutes`,
    "",
    ...(isVideo(extract)
      ? [
        lessonIndex === 0
          ? `This is lesson 1 — include exactly ONE embed block with url="${extract.url}" provider="youtube".`
          : `This is NOT lesson 1 — do not include the source video embed.`,
        "",
      ]
      : []),
    "Submit the blocks for this lesson via the submit_blocks tool.",
  ].join("\n");

  const { input, usage } = await callTool({
    model: MODELS.reasoning,
    maxTokens: 16384,
    cachedSystem: `${system(extract)}\n\n--- SOURCE CORPUS ---\n${corpus}`,
    userMessage: userMsg,
    toolName: "submit_blocks",
    toolDescription: "Submit the ordered content blocks that make up this lesson body.",
    inputSchema: INPUT_SCHEMA,
  });

  const wrapper = z.object({ blocks: z.array(z.unknown()) }).safeParse(input);
  if (!wrapper.success) {
    throw new ModelOutputError(`Tool input missing 'blocks' array for lesson ${lessonIndex + 1}`, usage);
  }

  // A refused block is dropped and reported rather than failing the run: a run
  // is 1 + 2N model calls, the course lands as an unpublished draft the author
  // reviews, and refused blocks are almost always invented media addresses the
  // author would delete anyway. A lesson left with under two blocks still fails.
  const kept: AuthorableBlock[] = [];
  const dropped: DroppedBlock[] = [];
  wrapper.data.blocks.forEach((candidate, i) => {
    const parsed = AuthorableBlock.safeParse(candidate);
    if (parsed.success) {
      kept.push(parsed.data);
      return;
    }
    const kind =
      candidate && typeof candidate === "object" && "kind" in candidate
        ? String((candidate as { kind: unknown }).kind)
        : "<no kind>";
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    dropped.push({
      lesson: lessonIndex + 1,
      position: i + 1,
      kind,
      reason: `${field ? `${field}: ` : ""}${issue?.message ?? "not a valid block"}`,
    });
  });
  if (kept.length < 2) {
    const refused = dropped.map((d) => `block ${d.position} (${d.kind}) ${d.reason}`).join("; ");
    throw new ModelOutputError(
      `Lesson ${lessonIndex + 1} produced only ${kept.length} valid block(s) after filtering.${refused ? ` Refused: ${refused}` : ""}`,
      usage,
    );
  }
  return { blocks: kept, dropped, usage };
}
