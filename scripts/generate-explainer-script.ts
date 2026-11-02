#!/usr/bin/env tsx
import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getClaude, MODELS } from "@/lib/ai/claude";
import { foritMark } from "@/lib/forit-brand";
import { getThemeForSlug } from "@/lib/tenant";
import type { CourseSeed } from "@/db/seed/course-seed";

const DraftSchema = z.object({
  kicker: z.string().min(1).max(40),
  title: z.string().min(1).max(80),
  beats: z
    .array(
      z.object({
        heading: z.string().max(40).optional(),
        lines: z.array(z.string().min(1).max(120)).min(1).max(4),
      }),
    )
    .min(3)
    .max(7),
  closing: z.object({ headline: z.string().min(1).max(60), sub: z.string().max(100).optional() }),
});

const SYSTEM = `You write the script for a 60-90 second vertical explainer video: kinetic typography on a brand background with a narrator reading every line aloud, in the style of viral short-form tech explainers, but for workplace training.

Rules:
- Use only facts from the lesson you are given. Invent nothing. Never mention the platform or the course itself.
- Every line is spoken verbatim by the narrator AND shown on screen, so write for the ear: plain words, one complete sentence per line, 5 to 12 words, no semicolons, no dashes, no bullets, no quotation marks.
- Mark the one or two words that carry each line with **double asterisks**. No other markup.
- kicker: 2 to 4 words naming the topic. title: the hook, at most 7 words, provocative or surprising.
- 4 to 6 beats. Each beat has an optional heading of at most 3 words and 2 to 3 lines. Line 1 of each beat is the punchy claim, the rest explain it.
- closing.headline: at most 6 words, the single behaviour to remember. closing.sub: at most 10 words, a direct instruction.
- Total spoken words across title, lines and closing: 140 to 200.`;

const TOOL = {
  name: "emit_script",
  description: "Emit the finished explainer script.",
  input_schema: {
    type: "object" as const,
    properties: {
      kicker: { type: "string" },
      title: { type: "string" },
      beats: {
        type: "array",
        items: {
          type: "object",
          properties: { heading: { type: "string" }, lines: { type: "array", items: { type: "string" } } },
          required: ["lines"],
        },
      },
      closing: { type: "object", properties: { headline: { type: "string" }, sub: { type: "string" } }, required: ["headline"] },
    },
    required: ["kicker", "title", "beats", "closing"],
  },
};

function lessonMarkdown(course: CourseSeed, lessonIndex: number) {
  const lesson = course.lessons[lessonIndex];
  if (!lesson) throw new Error(`lesson ${lessonIndex} not found in ${course.slug} (${course.lessons.length} lessons)`);
  const body = lesson.blocks
    .map((b) => ("markdown" in b && typeof b.markdown === "string" ? b.markdown : ""))
    .filter(Boolean)
    .join("\n\n");
  return { lesson, body };
}

function spokenWords(draft: z.infer<typeof DraftSchema>): number {
  const all = [draft.title, ...draft.beats.flatMap((b) => b.lines), draft.closing.headline, draft.closing.sub ?? ""];
  return all.join(" ").replace(/\*\*/g, "").trim().split(/\s+/).filter(Boolean).length;
}

// The video renders outside the app, so a mark the app serves from /brand/ goes
// into the script as a data URI.
function inlineLogo(url: string | undefined): string | undefined {
  const mark = url?.startsWith("/brand/") ? foritMark(url.slice("/brand/".length)) : null;
  return mark ? `data:${mark.contentType};base64,${mark.bytes.toString("base64")}` : url;
}

async function main() {
  const [slug, lessonArg, tenantArg] = process.argv.slice(2);
  const tenantSlug = tenantArg ?? process.env.LMS_APEX_TENANT_SLUG;
  if (!slug || !tenantSlug) {
    console.error("Usage: tsx scripts/generate-explainer-script.ts <course-slug> [lesson-index=0] [tenant-slug=$LMS_APEX_TENANT_SLUG]");
    process.exit(1);
  }
  const lessonIndex = Number(lessonArg ?? 0);
  const t = await getThemeForSlug(tenantSlug);
  if (!t) throw new Error(`no tenant ${tenantSlug}`);
  const mod = await import(pathToFileURL(path.resolve("db/seed/courses", `${slug}.course.ts`)).href);
  const course: CourseSeed = mod.default ?? mod.course;
  const { lesson, body } = lessonMarkdown(course, lessonIndex);

  const res = await getClaude().messages.create({
    model: MODELS.reasoning,
    max_tokens: 2000,
    system: SYSTEM,
    tools: [TOOL],
    tool_choice: { type: "tool", name: TOOL.name },
    messages: [
      {
        role: "user",
        content: `Course: ${course.title}\nLesson: ${lesson.title}\n\n${body}`,
      },
    ],
  });
  const call = res.content.find((c) => c.type === "tool_use");
  if (!call || call.type !== "tool_use") throw new Error(`no tool_use block in response (stop_reason=${res.stop_reason})`);
  const input = call.input as Record<string, unknown>;
  const raw = typeof input.script === "object" && input.script !== null ? input.script : input;
  const parsed = DraftSchema.safeParse(raw);
  if (!parsed.success) {
    console.error("draft failed validation:", JSON.stringify(raw).slice(0, 3000));
    throw new Error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const draft = parsed.data;

  const script = {
    theme: {
      company_name: t.company_name,
      primary_color: t.primary_color,
      secondary_color: t.secondary_color,
      accent_color: t.accent_color,
      font_family: t.font_family,
      logo_white_url: inlineLogo(t.logo_white_url),
    },
    course: { title: course.title, lesson: lesson.title },
    ...draft,
  };

  const out = path.resolve("video/scripts", `${slug}-lesson-${lessonIndex + 1}.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(script, null, 2) + "\n");
  console.log(
    JSON.stringify({
      out: path.relative(process.cwd(), out),
      model: res.model,
      beats: draft.beats.length,
      spokenWords: spokenWords(draft),
      usage: res.usage,
    }),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
