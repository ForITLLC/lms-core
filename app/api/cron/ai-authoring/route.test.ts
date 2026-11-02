import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// The authoring worker answers only the CRON_SECRET bearer, like the other
// /api/cron routes, runs one job per call within the stage budget, and its
// answer carries ids and an outcome, never a job's content or error text.

const SECRET = "s3cret-for-tests";
const JOB = "abababab-0000-0000-0000-0000000000ab";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";

function load(env: Record<string, string | undefined>, process: () => Promise<unknown>) {
  const calls: unknown[] = [];
  const logs: unknown[][] = [];
  const code = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = {
    "@/lib/ai/authoring/job": {
      STAGE_BUDGET_MS: 200_000,
      processNextIngestion: async (options: unknown) => { calls.push(options); return process(); },
    },
    "@/lib/logging": {
      recordError: async (...args: unknown[]) => { logs.push(["error", ...args]); },
      recordServiceRun: async (...args: unknown[]) => { logs.push(["run", ...args]); },
    },
  };
  const exports: any = {};
  runInNewContext(code, { exports, Response, Date, Error, String, process: { env }, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return { route: exports, calls, logs };
}

const post = (authorization?: string) =>
  new Request("https://lms.example/api/cron/ai-authoring", { method: "POST", headers: authorization ? { authorization } : {} });

test("no bearer, a wrong one, or no CRON_SECRET set is 403 and runs nothing", async () => {
  for (const [env, auth] of [
    [{ CRON_SECRET: SECRET }, undefined],
    [{ CRON_SECRET: SECRET }, "Bearer wrong"],
    [{ CRON_SECRET: SECRET }, SECRET],
    [{ CRON_SECRET: "" }, "Bearer "],
    [{}, "Bearer undefined"],
  ] as const) {
    const app = load(env, async () => ({ outcome: "idle" }));
    const res = await app.route.POST(post(auth));
    assert.equal(res.status, 403, JSON.stringify([env, auth]));
    assert.equal(app.calls.length, 0);
  }
});

test("the worker runs one job per call within the stage budget, under the five-minute function limit", async () => {
  const app = load({ CRON_SECRET: SECRET }, async () => ({ outcome: "completed", ingestionId: JOB, courseId: COURSE, course: { title: "Secret title" } }));
  assert.equal(app.route.maxDuration, 300);
  const res = await app.route.POST(post(`Bearer ${SECRET}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, outcome: "completed", ingestionId: JOB, courseId: COURSE });
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls)), [{ budgetMs: 200_000 }]);

  const idle = load({ CRON_SECRET: SECRET }, async () => ({ outcome: "idle" }));
  assert.deepEqual(await (await idle.route.POST(post(`Bearer ${SECRET}`))).json(), { ok: true, outcome: "idle", ingestionId: null, courseId: null });
  const failed = load({ CRON_SECRET: SECRET }, async () => ({ outcome: "failed", ingestionId: JOB, error: "the transcript said something private" }));
  const body = await (await failed.route.POST(post(`Bearer ${SECRET}`))).json();
  assert.deepEqual(body, { ok: true, outcome: "failed", ingestionId: JOB, courseId: null });
});

test("a worker that throws answers 500 with no detail and logs the failure", async () => {
  const app = load({ CRON_SECRET: SECRET }, async () => { throw new Error("Login failed for user 'lms'"); });
  const res = await app.route.POST(post(`Bearer ${SECRET}`));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "The authoring worker failed" });
  assert.deepEqual(app.logs.map((l) => [l[0], l[1]]), [["error", "lms-ai-authoring"], ["run", "lms-ai-authoring"]]);
});
