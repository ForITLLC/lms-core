import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import * as quizSchema from "@/lib/schema/quiz";
import * as usageModule from "./usage";
import * as source from "./source";
import { addUsage, callUsage, ModelOutputError, readUsage, tokenTotals, type Usage } from "./usage";

// Token usage per model call, as callTool reads it from the Messages API
// response and the generators hand it back to the job. No model is called.

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function vmLoad(file: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Error, Promise, JSON, String, Number, Math, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return exports;
}

function fakeClaude(response: Record<string, unknown>) {
  const sent: any[] = [];
  const claude = {
    getClaude: () => ({ messages: { create: async (body: unknown) => { sent.push(body); return response; } } }),
    buildCachedSystem: (text: string) => [{ type: "text", text, cache_control: { type: "ephemeral" } }],
  };
  return { util: vmLoad("./util.ts", { "@/lib/ai/claude": claude, "./usage": usageModule }), sent };
}

const OPTS = {
  model: "requested-model", maxTokens: 100, cachedSystem: "sys", userMessage: "go",
  toolName: "submit_x", toolDescription: "d", inputSchema: { type: "object" },
};

test("callTool hands back the tool input with the response's model and usage; a missing count is 0", async () => {
  const { util } = fakeClaude({
    model: "claude-sonnet-4-6", stop_reason: "tool_use",
    content: [{ type: "tool_use", name: "submit_x", input: { a: 1 } }],
    usage: { input_tokens: 12, output_tokens: 34, cache_creation_input_tokens: null },
  });
  assert.deepEqual(plain(await util.callTool(OPTS)), {
    input: { a: 1 },
    usage: { model: "claude-sonnet-4-6", inputTokens: 12, outputTokens: 34, cacheWriteTokens: 0, cacheReadTokens: 0 },
  });

  const { util: bare } = fakeClaude({ stop_reason: "tool_use", content: [{ type: "tool_use", name: "submit_x", input: {} }] });
  assert.deepEqual(plain((await bare.callTool(OPTS)).usage), { model: "requested-model", inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 });
});

test("an answer callTool can't use still carries what it cost", async () => {
  const usage = { input_tokens: 5, output_tokens: 100, cache_creation_input_tokens: 7, cache_read_input_tokens: 9 };
  const spent = { model: "claude-opus-4-7", inputTokens: 5, outputTokens: 100, cacheWriteTokens: 7, cacheReadTokens: 9 };
  for (const [response, message] of [
    [{ model: "claude-opus-4-7", stop_reason: "max_tokens", content: [], usage }, /^Tool call to 'submit_x' hit max_tokens \(100\)\.$/],
    [{ model: "claude-opus-4-7", stop_reason: "end_turn", content: [{ type: "text", text: "no" }], usage }, /^Model did not call tool 'submit_x'\. Stop reason: end_turn\./],
  ] as const) {
    const { util } = fakeClaude(response);
    await assert.rejects(util.callTool(OPTS), (err: unknown) =>
      err instanceof ModelOutputError && message.test(err.message) && JSON.stringify(err.usage) === JSON.stringify(spent));
  }
});

test("the outline and quiz generators return their call's usage, and a schema refusal carries it", async () => {
  const spent = { model: "bulk-model", inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 };
  const extract = { kind: "youtube", title: "V", author: "A", url: "https://youtu.be/x", text: "t", approxMinutes: 1, videoId: "x", thumbnailUrl: "", transcriptSource: "yt-dlp" };
  const lesson = { title: "L", summary: "S", objectives: ["Explain"], estMinutes: 10 };
  const outlineInput = { title: "T", slug: "t-course", description: "D", lessons: [lesson, lesson, lesson] };
  const quizInput = { questions: [
    { kind: "tf", promptMd: "a", correctValue: true },
    { kind: "tf", promptMd: "b", correctValue: false },
    { kind: "tf", promptMd: "c", correctValue: true },
  ] };
  const load = (file: string, input: unknown) => vmLoad(file, {
    zod, "@/lib/ai/claude": { MODELS: { reasoning: "reasoning-model", bulk: "bulk-model" } },
    "@/lib/schema/quiz": quizSchema, "./usage": usageModule, "./source": source,
    "./util": { callTool: async () => ({ input, usage: spent }) },
  });

  assert.deepEqual(plain(await load("./outline.ts", outlineInput).generateOutline(extract)), { ...outlineInput, usage: spent });
  assert.deepEqual(plain(await load("./quiz.ts", quizInput).generateQuiz({ extract, courseTitle: "T", lesson, lessonIndex: 0 })), { ...quizInput, usage: spent });
  const carries = (err: unknown) => err instanceof ModelOutputError && JSON.stringify(err.usage) === JSON.stringify(spent);
  await assert.rejects(load("./outline.ts", { title: "T" }).generateOutline(extract), carries);
  await assert.rejects(load("./quiz.ts", { questions: [] }).generateQuiz({ extract, courseTitle: "T", lesson, lessonIndex: 0 }), carries);
});

test("addUsage adds one call to its model's totals and leaves the total it was given alone", () => {
  const start: Usage = {};
  const one = addUsage(start, { model: "a", inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 });
  const two = addUsage(one, { model: "a", inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 });
  const three = addUsage(two, callUsage("b", { input_tokens: 7 }));
  assert.deepEqual(start, {});
  assert.deepEqual(one, { a: { calls: 1, inputTokens: 1, outputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 4 } });
  assert.deepEqual(three, {
    a: { calls: 2, inputTokens: 11, outputTokens: 22, cacheWriteTokens: 33, cacheReadTokens: 44 },
    b: { calls: 1, inputTokens: 7, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 },
  });
  assert.deepEqual(readUsage(JSON.stringify(three)), three);
  assert.deepEqual(tokenTotals(three), { tokensIn: 11 + 33 + 44 + 7, tokensOut: 22 });
  assert.deepEqual(tokenTotals({}), { tokensIn: 0, tokensOut: 0 });
});
