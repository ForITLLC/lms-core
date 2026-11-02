import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import * as blockSchemas from "@/lib/schema/blocks";
import * as quizSchema from "@/lib/schema/quiz";
import * as usageModule from "./usage";
import * as source from "./source";
import type { SourceExtract } from "./source";

// The prompts per source kind (docs/plans/2026-10-29-ai-authoring.md, slice A3):
// the corpus header names the source, only a video gets the lesson-1 embed
// instruction, and a YouTube source's prompts are byte for byte what they
// were before A3, so its cached system prompt is unchanged.

function vmLoad(file: URL, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Error, Promise, JSON, String, Number, Math, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return exports;
}

interface Call { model: string; cachedSystem: string; userMessage: string; toolName: string; inputSchema: any }

function prompts() {
  const calls: Call[] = [];
  const modules = {
    zod,
    "./source": source,
    "./usage": usageModule,
    "@/lib/schema/blocks": blockSchemas,
    "@/lib/schema/quiz": quizSchema,
    "@/lib/ai/claude": { MODELS: { reasoning: "reasoning-model", bulk: "bulk-model" } },
    "./util": { callTool: async (call: Call) => { calls.push(call); throw new Error("stop after the prompt"); } },
  };
  const outline = vmLoad(new URL("./outline.ts", import.meta.url), modules);
  const blocks = vmLoad(new URL("./blocks.ts", import.meta.url), modules);
  const quiz = vmLoad(new URL("./quiz.ts", import.meta.url), modules);
  const lesson = { title: "Vortices", summary: "Where they form", objectives: ["Explain vortices", "Avoid them"], estMinutes: 12 };
  return {
    calls,
    async outline(extract: SourceExtract, options?: unknown) {
      calls.length = 0;
      await assert.rejects(outline.generateOutline(extract, options), /stop after the prompt/);
      return calls[0]!;
    },
    async run(extract: SourceExtract) {
      calls.length = 0;
      await assert.rejects(outline.generateOutline(extract), /stop after the prompt/);
      for (const lessonIndex of [0, 1]) {
        await assert.rejects(blocks.generateBlocks({ extract, courseTitle: "Wake", lesson, lessonIndex, totalLessons: 4 }), /stop after the prompt/);
      }
      for (const lessonIndex of [0, 1]) {
        await assert.rejects(quiz.generateQuiz({ extract, courseTitle: "Wake", lesson, lessonIndex }), /stop after the prompt/);
      }
      const [outlineCall, blocks1, blocks2, quiz1, quiz2] = calls;
      return { outline: outlineCall!, blocks1: blocks1!, blocks2: blocks2!, quiz1: quiz1!, quiz2: quiz2! };
    },
  };
}

const VIDEO: SourceExtract = {
  kind: "youtube", title: "Wake turbulence basics", author: "Flight School", url: "https://www.youtube.com/watch?v=abc123",
  text: "Line one.\nLine two about vortices.", approxMinutes: 13, videoId: "abc123", thumbnailUrl: "https://i.ytimg.com/x.jpg",
  transcriptSource: "yt-dlp",
};
const PAGE: SourceExtract = {
  kind: "url", title: "Wake turbulence", author: "aviation.example", url: "https://aviation.example/wake",
  text: "Vortices trail from wingtips.\nThey sink and drift.", approxMinutes: 2,
};
const PASTE: SourceExtract = {
  kind: "text", title: "Hangar notes", author: null, url: null, text: "Chock the wheels.\nCheck the tow bar.", approxMinutes: 1,
};

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const EMBED = /embed/i;

test("a YouTube source's prompts are byte for byte what they were before A3", async () => {
  const p = await prompts().run(VIDEO);
  // Captured from main at 38f5574 with the same video and lesson.
  assert.deepEqual(
    [p.outline, p.blocks1, p.blocks2, p.quiz1, p.quiz2].map((c) => [c.toolName, sha(c.cachedSystem), sha(c.userMessage)]),
    [
      ["submit_outline", "5393c090a6269565d1b724ec5847dc57c8c7b821dde3705a6ec332e0320aedfb", "644c2d9a91da3a6c7928d2e5d785d46037750d482bb75afefd2cbbbf31c0170d"],
      ["submit_blocks", "278e69aa65b0ecb6e526ab9c42669c026326be1de19f06bfddf8643f01754c42", "4527afaa4779985a5553fdc43c1d4a246409784420c8cc1717f8da3644debbf4"],
      ["submit_blocks", "278e69aa65b0ecb6e526ab9c42669c026326be1de19f06bfddf8643f01754c42", "9b284f2eae168c921ef520b3ff7bfcf695ab7bab98f95236405bd9f2f61a7354"],
      ["submit_quiz", "10e1e36d423b8517cbc89704a86b32a25d51673b499830429fefd51a647269cd", "ecfc316b1c870d10b7972540f29760951005bc84bed8e9901c2311eec3cde0c4"],
      ["submit_quiz", "10e1e36d423b8517cbc89704a86b32a25d51673b499830429fefd51a647269cd", "3aef1e55bafa7f308e13deae13477e019ddfc12a815534d67f5e0a8e30c913ae"],
    ],
  );
  assert.match(p.outline.cachedSystem, /--- SOURCE CORPUS ---\nSource: YouTube video "Wake turbulence basics" by Flight School\nURL: https:\/\/www\.youtube\.com\/watch\?v=abc123\nDuration: ~13 minutes\n\nTRANSCRIPT:\nLine one\./);
  assert.match(p.blocks1.cachedSystem, /Embed the source video EXACTLY ONCE as an "embed" block/);
  assert.match(p.blocks1.userMessage, /This is lesson 1 — include exactly ONE embed block with url="https:\/\/www\.youtube\.com\/watch\?v=abc123" provider="youtube"\./);
  assert.match(p.blocks2.userMessage, /This is NOT lesson 1 — do not include the source video embed\./);
});

test("a web page's corpus header names the page and its site, and no prompt asks for an embed", async () => {
  const p = await prompts().run(PAGE);
  const header = 'Source: web page "Wake turbulence" from aviation.example\nURL: https://aviation.example/wake';
  assert.ok(p.outline.cachedSystem.includes(`--- SOURCE CORPUS ---\n${header}\nLength: ~2 minutes of reading\n\nPAGE TEXT:\nVortices trail`));
  assert.ok(p.blocks1.cachedSystem.includes(`--- SOURCE CORPUS ---\n${header}\nLength: ~2 minutes of reading\n\nPAGE TEXT:\n`));
  assert.ok(p.quiz1.cachedSystem.includes(`--- SOURCE CORPUS ---\n${header}\n\nPAGE TEXT:\n`));
  assert.match(p.outline.cachedSystem, /Produce a course outline from the source text\./);
  assert.match(p.blocks1.cachedSystem, /Use the source text as the factual basis/);
  for (const call of [p.blocks1, p.blocks2]) {
    assert.doesNotMatch(call.userMessage, EMBED);
    assert.doesNotMatch(call.cachedSystem.split("--- SOURCE CORPUS ---")[0]!.replace('"embed", ', ""), EMBED);
  }
  assert.equal(p.blocks1.userMessage.split("\n").at(-1), "Submit the blocks for this lesson via the submit_blocks tool.");
  assert.doesNotMatch(p.blocks1.cachedSystem, /YouTube|TRANSCRIPT|transcript/);
});

test("pasted text's corpus header names it as pasted, with no URL, and no prompt asks for an embed", async () => {
  const p = await prompts().run(PASTE);
  const corpus = '--- SOURCE CORPUS ---\nSource: pasted text "Hangar notes"\nLength: ~1 minutes of reading\n\nTEXT:\nChock the wheels.\nCheck the tow bar.';
  assert.ok(p.outline.cachedSystem.endsWith(corpus));
  assert.ok(p.blocks1.cachedSystem.endsWith(corpus));
  assert.ok(p.quiz1.cachedSystem.endsWith('--- SOURCE CORPUS ---\nSource: pasted text "Hangar notes"\n\nTEXT:\nChock the wheels.\nCheck the tow bar.'));
  for (const call of [p.blocks1, p.blocks2]) {
    assert.doesNotMatch(call.userMessage, EMBED);
    assert.doesNotMatch(call.cachedSystem.split("--- SOURCE CORPUS ---")[0]!.replace('"embed", ', ""), EMBED);
  }
  assert.doesNotMatch(p.outline.cachedSystem, /URL:|YouTube/);
});

test("the corpus stays in the cached system prompt for every kind; the user message carries only the lesson", async () => {
  const run = prompts();
  for (const extract of [VIDEO, PAGE, PASTE]) {
    const p = await run.run(extract);
    for (const call of [p.outline, p.blocks1, p.blocks2, p.quiz1, p.quiz2]) {
      assert.ok(call.cachedSystem.includes(extract.text), `${extract.kind} ${call.toolName}`);
      assert.ok(!call.userMessage.includes(extract.text), `${extract.kind} ${call.toolName}`);
    }
  }
  const util = readFileSync(new URL("./util.ts", import.meta.url), "utf8");
  assert.match(util, /system: buildCachedSystem\(opts\.cachedSystem\)/);
});

test("an author's lesson count is asked for in the outline prompt and bounds the tool's lesson list; with none the outline call is unchanged", async () => {
  const run = prompts();
  const asked = await run.outline(VIDEO, { lessonCount: 5 });
  assert.match(asked.cachedSystem, /broken into 5 focused lessons that build on each other\./);
  assert.doesNotMatch(asked.cachedSystem, /4-8/);
  assert.deepEqual([asked.inputSchema.properties.lessons.minItems, asked.inputSchema.properties.lessons.maxItems], [5, 5]);

  const before = await run.outline(VIDEO);
  assert.match(before.cachedSystem, /broken into 4-8 focused lessons/);
  assert.deepEqual([before.inputSchema.properties.lessons.minItems, before.inputSchema.properties.lessons.maxItems], [3, 10]);
  for (const options of [{}, { lessonCount: null }, { lessonCount: undefined }]) {
    const same = await run.outline(VIDEO, options);
    assert.deepEqual([sha(same.cachedSystem), sha(same.userMessage), JSON.stringify(same.inputSchema)],
      [sha(before.cachedSystem), sha(before.userMessage), JSON.stringify(before.inputSchema)], JSON.stringify(options));
  }
  assert.equal(sha(before.cachedSystem), "5393c090a6269565d1b724ec5847dc57c8c7b821dde3705a6ec332e0320aedfb");
  for (const n of [3, 10]) {
    const call = await run.outline(PASTE, { lessonCount: n });
    assert.match(call.cachedSystem, new RegExp(`broken into ${n} focused lessons`));
    assert.deepEqual([call.inputSchema.properties.lessons.minItems, call.inputSchema.properties.lessons.maxItems], [n, n]);
  }
});
