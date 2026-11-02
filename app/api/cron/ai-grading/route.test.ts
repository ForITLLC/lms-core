import { test } from "node:test";
import assert from "node:assert/strict";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";

// The AI marking worker answers only the CRON_SECRET bearer, like the other
// /api/cron routes, runs within its budget and job cap, and its answer
// carries counts by outcome, never an answer, a mark or an error's text.

const SECRET = "s3cret-for-tests";

function load(env: Record<string, string | undefined>, run: () => Promise<unknown[]>) {
  const calls: unknown[] = [];
  const logs: unknown[][] = [];
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    "@/lib/ai/grading/job": {
      GRADING_BUDGET_MS: 200_000,
      SERVICE: "lms-ai-grading",
      processGradingJobs: async (options: unknown) => { calls.push(options); return run(); },
    },
    "@/lib/logging": {
      recordError: async (...args: unknown[]) => { logs.push(["error", ...args]); },
      recordServiceRun: async (...args: unknown[]) => { logs.push(["run", ...args]); },
    },
  }, { process: { env } });
  return { route, calls, logs };
}

const post = (authorization?: string) =>
  new Request("https://lms.example/api/cron/ai-grading", { method: "POST", headers: authorization ? { authorization } : {} });

test("no bearer, a wrong one, or no CRON_SECRET set is 403 and runs nothing", async () => {
  for (const [env, auth] of [
    [{ CRON_SECRET: SECRET }, undefined],
    [{ CRON_SECRET: SECRET }, "Bearer wrong"],
    [{ CRON_SECRET: SECRET }, SECRET],
    [{ CRON_SECRET: "" }, "Bearer "],
    [{}, "Bearer undefined"],
  ] as const) {
    const app = load(env, async () => []);
    const res = await app.route.POST(post(auth));
    assert.equal(res.status, 403, JSON.stringify([env, auth]));
    assert.equal(app.calls.length, 0);
  }
});

test("the worker runs within its budget and cap, under the five-minute limit, and answers counts only", async () => {
  const app = load({ CRON_SECRET: SECRET }, async () => [
    { outcome: "marked", jobId: "j1", gradeId: "g1" },
    { outcome: "marked", jobId: "j2", gradeId: "g2" },
    { outcome: "failed", jobId: "j3", error: "the learner wrote something private" },
    { outcome: "cancelled", jobId: "j4" },
  ]);
  assert.equal(app.route.maxDuration, 300);
  const res = await app.route.POST(post(`Bearer ${SECRET}`));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, processed: 4, outcomes: { marked: 2, failed: 1, cancelled: 1 } });
  assert.deepEqual(JSON.parse(JSON.stringify(app.calls)), [{ budgetMs: 200_000, maxJobs: 50 }]);

  const idle = load({ CRON_SECRET: SECRET }, async () => []);
  assert.deepEqual(await (await idle.route.POST(post(`Bearer ${SECRET}`))).json(), { ok: true, processed: 0, outcomes: {} });
});

test("a worker that throws answers 500 with no detail and logs the failure", async () => {
  const app = load({ CRON_SECRET: SECRET }, async () => { throw new Error("Login failed for user 'lms'"); });
  const res = await app.route.POST(post(`Bearer ${SECRET}`));
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { ok: false, error: "The marking worker failed" });
  assert.deepEqual(app.logs.map((l) => [l[0], l[1]]), [["error", "lms-ai-grading"], ["run", "lms-ai-grading"]]);
});
