import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";

// An author reads the progress of their own tenant's authoring job: never
// another tenant's, never cached, and never the job's work, which holds the
// source's text.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const OTHER = "0f0f0f0f-0000-0000-0000-00000000000f";
const JOB = "abababab-0000-0000-0000-0000000000ab";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";

function evaluate(path: URL, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Response, Date, JSON, Promise, Error, String, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return exports;
}

type Session = { tenantId?: string; email: string; role?: string } | null;

const job = {
  ingestionId: JOB, status: "queued", stage: "lessons", lessonsDone: 2, lessonsTotal: 3, attempts: 1,
  sourceKind: "youtube", sourceRef: "https://youtu.be/x",
  warnings: [{ lesson: 2, position: 2, kind: "image", reason: "url: Enter a web address" }],
  usage: { "claude-opus-4-7": { calls: 2, inputTokens: 200, outputTokens: 4000, cacheWriteTokens: 0, cacheReadTokens: 10000 } },
  courseId: null, error: "429 rate limited", createdBy: "a@example.test",
  createdAt: new Date(Date.UTC(2026, 9, 29, 12)), updatedAt: new Date(Date.UTC(2026, 9, 29, 12, 1)), notBefore: new Date(Date.UTC(2026, 9, 29, 12, 2)),
  workJson: "{\"extract\":{\"transcript\":\"secret\"}}", optionsJson: "{}",
};

function load(session: Session, opts: { record?: Record<string, unknown>; fail?: boolean } = {}) {
  const calls: unknown[][] = [];
  const logs: unknown[][] = [];
  const logging = {
    recordError: async (...args: unknown[]) => { logs.push(args); },
    recordServiceRun: async (...args: unknown[]) => { logs.push(args); },
  };
  const gate = evaluate(new URL("../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const kicks: unknown[] = [];
  const afters: (() => Promise<void>)[] = [];
  const kick = evaluate(new URL("../../../../../lib/ai/authoring/kick.ts", import.meta.url), {
    "@/lib/logging": logging,
    "./job": { STAGE_BUDGET_MS: 200_000, processNextIngestion: async (o: unknown) => { kicks.push(o); return { outcome: "idle" }; } },
  });
  const route = evaluate(new URL("./route.ts", import.meta.url), {
    "next/server": { after: (fn: () => Promise<void>) => { afters.push(fn); } },
    zod: { z },
    "@/lib/auth/staff-gate": gate,
    "@/lib/ai/authoring/kick": kick,
    "@/lib/db/ingestions": {
      getIngestion: async (tenantId: string, id: string) => {
        calls.push([tenantId, id]);
        if (opts.fail) throw new Error("Login failed for user 'lms'");
        return tenantId === TENANT && id === JOB ? opts.record ?? job : null;
      },
    },
  });
  return { route, calls, logs, kicks, afters };
}

const get = (app: ReturnType<typeof load>, id: string) =>
  app.route.GET(new Request(`https://tenant.example/api/author/ingestions/${id}`), { params: Promise.resolve({ id }) });

test("signed out is 401, no tenant is 400, a learner is 403, and none of them reads a job", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@example.test", role: "author" }, 400],
    [{ tenantId: TENANT, email: "x@example.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@example.test" }, 403],
  ] as const) {
    const app = load(session);
    const res = await get(app, JOB);
    assert.equal(res.status, status, JSON.stringify(session));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(app.calls.length, 0);
  }
});

test("an author sees their own tenant's job: status, stage, progress, warnings and retry time, never its work", async () => {
  for (const role of ["author", "admin"]) {
    const app = load({ tenantId: TENANT, email: `${role}@example.test`, role });
    const res = await get(app, JOB.toUpperCase());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(app.calls, [[TENANT, JOB]]);
    const body = await res.json();
    assert.deepEqual(body, { ingestion: {
      id: JOB, status: "queued", stage: "lessons", lessonsDone: 2, lessonsTotal: 3, attempts: 1,
      source: { kind: "youtube", ref: "https://youtu.be/x" }, warnings: job.warnings, usage: job.usage, courseId: null, error: "429 rate limited",
      retryAt: "2026-10-29T12:02:00.000Z", createdAt: "2026-10-29T12:00:00.000Z", updatedAt: "2026-10-29T12:01:00.000Z",
    } });
    assert.doesNotMatch(JSON.stringify(body), /secret|workJson|optionsJson|createdBy/i);
  }
  const done = load({ tenantId: TENANT, email: "a@example.test", role: "author" }, { record: { ...job, status: "completed", courseId: COURSE, error: null } });
  const body = await (await get(done, JOB)).json();
  assert.deepEqual([body.ingestion.courseId, body.ingestion.retryAt], [COURSE, null]);
});

test("the status read returns the job's token usage per model, and still never its work or options", async () => {
  const usage = {
    "claude-sonnet-4-6": { calls: 5, inputTokens: 1200, outputTokens: 1400, cacheWriteTokens: 5000, cacheReadTokens: 20000 },
    "claude-opus-4-7": { calls: 3, inputTokens: 300, outputTokens: 6000, cacheWriteTokens: 0, cacheReadTokens: 15000 },
  };
  const app = load({ tenantId: TENANT, email: "a@example.test", role: "author" }, {
    record: { ...job, status: "completed", courseId: COURSE, error: null, usage, WorkJson: "{\"transcript\":\"secret\"}", OptionsJson: "{\"lessons\":4}" },
  });
  const res = await get(app, JOB);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.ingestion.usage, usage);
  assert.deepEqual(Object.keys(body.ingestion).sort(), [
    "attempts", "courseId", "createdAt", "error", "id", "lessonsDone", "lessonsTotal", "retryAt", "source", "stage", "status", "updatedAt", "usage", "warnings",
  ]);
  assert.doesNotMatch(JSON.stringify(body), /secret|workJson|optionsJson|"lessons":4/i);

  const none = load({ tenantId: TENANT, email: "a@example.test", role: "author" }, { record: { ...job, usage: {} } });
  assert.deepEqual((await (await get(none, JOB)).json()).ingestion.usage, {});
});

test("reading a job that is due kicks one worker pass after the answer; one running under a live lease, waiting, or finished doesn't", async () => {
  const now = Date.now();
  const at = (ms: number) => new Date(now + ms);
  const cases: [Record<string, unknown>, number][] = [
    [{ status: "queued", notBefore: at(-1000), leaseUntil: null }, 1],
    [{ status: "running", notBefore: at(-60_000), leaseUntil: at(-1000) }, 1],
    [{ status: "queued", notBefore: at(60_000), leaseUntil: null }, 0],
    [{ status: "running", notBefore: at(-60_000), leaseUntil: at(60_000) }, 0],
    [{ status: "completed", notBefore: at(-60_000), leaseUntil: null, courseId: COURSE }, 0],
    [{ status: "failed", notBefore: at(-60_000), leaseUntil: null }, 0],
  ];
  for (const [fields, expected] of cases) {
    const app = load({ tenantId: TENANT, email: "a@example.test", role: "author" }, { record: { ...job, ...fields } });
    assert.equal((await get(app, JOB)).status, 200);
    assert.equal(app.kicks.length, 0, "never before the answer");
    assert.equal(app.afters.length, expected, JSON.stringify(fields));
    for (const fn of app.afters) await fn();
    assert.equal(app.kicks.length, expected);
  }
  const other = load({ tenantId: OTHER, email: "a@example.test", role: "author" }, { record: { ...job, notBefore: at(-1000) } });
  assert.equal((await get(other, JOB)).status, 404);
  assert.equal(other.afters.length, 0, "another tenant's job is not found and kicks nothing");
});

test("another tenant's job, or something that isn't a job id, is 404", async () => {
  const other = load({ tenantId: OTHER, email: "a@example.test", role: "author" });
  const res = await get(other, JOB);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(other.calls, [[OTHER, JOB]]);

  const junk = load({ tenantId: TENANT, email: "a@example.test", role: "author" });
  for (const id of ["../../etc", "not-a-uuid", `${JOB}x`]) assert.equal((await get(junk, id)).status, 404, id);
  assert.equal(junk.calls.length, 0);
});

test("a failed read answers 500 without the error and logs it by message", async () => {
  const app = load({ tenantId: TENANT, email: "a@example.test", role: "author" }, { fail: true });
  const res = await get(app, JOB);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Something went wrong" });
  assert.deepEqual(app.logs.map((l) => l[0]), ["lms-ai-authoring"]);
});
