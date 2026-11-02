import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import * as options from "@/lib/ai/authoring/options";
import * as source from "@/lib/ai/authoring/source";
import * as usage from "@/lib/ai/authoring/usage";
import * as extractText from "@/lib/ai/authoring/extract-text";
import * as safeFetch from "@/lib/net/safe-fetch";
import { CourseOutline } from "@/lib/ai/authoring/outline";

// "Create with AI" (docs/plans/2026-10-29-ai-authoring.md, slice A4): an author
// or admin queues a job for the session's own tenant, only where the tenant is
// switched on and under its caps, and the worker is kicked once the answer has
// gone. The source is checked by the job's own ingestionInput, loaded for real.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const OTHER = "0f0f0f0f-0000-0000-0000-00000000000f";
const SLUGS: Record<string, string> = { [TENANT]: "tenant-a", [OTHER]: "tenant-b" };
const AUTHOR = { tenantId: TENANT, email: "author@example.test", role: "author" };
const VIDEO = "https://www.youtube.com/watch?v=abc123";
const THIS_MONTH = new Date();
const LAST_MONTH = new Date(Date.UTC(THIS_MONTH.getUTCFullYear(), THIS_MONTH.getUTCMonth(), 1) - 86_400_000);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function evaluate(path: URL, modules: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Response, Date, JSON, Promise, Error, String, Number, Math, Buffer, URL, Set, setTimeout, ...globals, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return exports;
}

const lib = (path: string) => new URL(`../../../../lib/${path}`, import.meta.url);

// The job module for its ingestionInput only; nothing here runs a job.
const extractUrl = evaluate(lib("ai/authoring/extract-url.ts"), {
  "@/lib/net/safe-fetch": safeFetch, "./extract-youtube": { extractYouTube: async () => { throw new Error("not here"); } }, "./source": source,
});
const job = evaluate(lib("ai/authoring/job.ts"), {
  zod: { z }, "@/lib/db/ingestions": {}, "@/lib/db/course-drafts": {}, "@/lib/logging": {}, "@/lib/ai/claude": {},
  "./extract-youtube": {}, "./extract-text": extractText, "./extract-url": extractUrl, "./source": source,
  "./outline": { CourseOutline }, "./blocks": {}, "./quiz": {}, "./draft": {}, "./options": options, "./usage": usage,
});

interface Job {
  ingestionId: string; tenantId: string; createdBy: string; sourceKind: string; sourceRef: string;
  optionsJson: string; status: string; createdAt: Date;
}

type Session = { tenantId?: string; email: string; role?: string } | null;

interface Setup {
  session?: Session;
  env?: Record<string, string | undefined>;
  jobs?: Partial<Job>[];
  failEnqueue?: boolean;
  failKick?: boolean;
}

function load(setup: Setup = {}) {
  let session: Session = setup.session === undefined ? AUTHOR : setup.session;
  const env = setup.env ?? { AI_AUTHORING_TENANTS: "tenant-a" };
  let n = 0;
  const jobs: Job[] = (setup.jobs ?? []).map((j) => ({
    ingestionId: `abababab-0000-0000-0000-${String(++n).padStart(12, "0")}`, tenantId: TENANT, createdBy: "x@example.test",
    sourceKind: "youtube", sourceRef: VIDEO, optionsJson: "{}", status: "queued", createdAt: THIS_MONTH, ...j,
  }));
  const enqueues: { tenantId: string; input: any; limits: any }[] = [];
  const slugReads: string[] = [];
  const kicks: unknown[] = [];
  const afters: (() => Promise<void>)[] = [];
  const runs: unknown[][] = [];
  const errors: unknown[][] = [];
  const logging = {
    recordServiceRun: async (...args: unknown[]) => { runs.push(args); },
    recordError: async (...args: unknown[]) => { errors.push(args); },
  };

  // The queue as enqueueIngestionWithinLimits keeps it: the counts are the
  // tenant's own jobs (lib/db/ingestions.test.ts holds the SQL to that).
  const monthStart = Date.UTC(THIS_MONTH.getUTCFullYear(), THIS_MONTH.getUTCMonth(), 1);
  const ingestions = {
    enqueueIngestionWithinLimits: async (tenantId: string, input: any, limits: any) => {
      enqueues.push({ tenantId, input, limits });
      if (setup.failEnqueue) throw new Error("Login failed for user 'lms'");
      const mine = jobs.filter((j) => j.tenantId === tenantId);
      const active = mine.filter((j) => j.status === "queued" || j.status === "running").length;
      const thisMonth = mine.filter((j) => j.createdAt.getTime() >= monthStart).length;
      if (active >= limits.maxActive || thisMonth >= limits.maxPerMonth) {
        return { queued: false, reached: thisMonth >= limits.maxPerMonth ? "monthly" : "active", active, thisMonth };
      }
      const ingestionId = `cdcdcdcd-0000-0000-0000-${String(++n).padStart(12, "0")}`;
      jobs.push({ ingestionId, tenantId, createdBy: input.createdBy, sourceKind: input.sourceKind, sourceRef: input.sourceRef,
        optionsJson: JSON.stringify(input.options), status: "queued", createdAt: new Date() });
      return { queued: true, ingestionId };
    },
    getIngestion: async (tenantId: string, id: string) => {
      const j = jobs.find((row) => row.tenantId === tenantId && row.ingestionId === id);
      return j ? {
        ingestionId: j.ingestionId, status: j.status, stage: null, lessonsDone: 0, lessonsTotal: null, attempts: 0,
        sourceKind: j.sourceKind, sourceRef: j.sourceRef, warnings: [], usage: {}, courseId: null, error: null, createdBy: j.createdBy,
        createdAt: j.createdAt, updatedAt: j.createdAt, notBefore: j.createdAt, leaseUntil: null,
      } : null;
    },
  };

  const gate = evaluate(lib("auth/staff-gate.ts"), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const limits = evaluate(lib("ai/authoring/limits.ts"), {
    "@/lib/db/tenants": { getTenantSlug: async (tenantId: string) => { slugReads.push(tenantId); return SLUGS[tenantId] ?? null; } },
  }, { process: { env } });
  const kick = evaluate(lib("ai/authoring/kick.ts"), {
    "@/lib/logging": logging,
    "./job": {
      STAGE_BUDGET_MS: 200_000,
      processNextIngestion: async (opts: unknown) => {
        kicks.push(opts);
        if (setup.failKick) throw new Error("claim failed");
        return { outcome: "idle" };
      },
    },
  });
  const nextServer = { after: (fn: () => Promise<void>) => { afters.push(fn); } };
  const route = evaluate(new URL("./route.ts", import.meta.url), {
    "next/server": nextServer,
    zod: { z },
    "@/lib/auth/staff-gate": gate,
    "@/lib/ai/authoring/job": { ingestionInput: job.ingestionInput },
    "@/lib/ai/authoring/kick": kick,
    "@/lib/ai/authoring/limits": limits,
    "@/lib/ai/authoring/options": options,
    "@/lib/ai/authoring/source": source,
    "@/lib/db/ingestions": ingestions,
    "@/lib/logging": logging,
  });
  const status = evaluate(new URL("./[id]/route.ts", import.meta.url), {
    "next/server": nextServer, zod: { z }, "@/lib/auth/staff-gate": gate, "@/lib/ai/authoring/kick": kick, "@/lib/db/ingestions": ingestions,
  });
  const post = (body: unknown) =>
    route.POST(new Request("https://tenant.example/api/author/ingestions", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
    })) as Promise<Response>;
  const read = (id: string) =>
    status.GET(new Request(`https://tenant.example/api/author/ingestions/${id}`), { params: Promise.resolve({ id }) }) as Promise<Response>;
  return {
    post, read, jobs, enqueues, slugReads, kicks, afters, runs, errors, limits,
    as: (next: Session) => { session = next; },
  };
}

const youtube = { source: { kind: "youtube", url: VIDEO }, options: { lessonCount: 5, quizzes: false } };

test("signed out is 401, no tenant is 400, a learner is 403: nothing is looked up, queued or kicked", async () => {
  for (const [session, code] of [
    [null, 401],
    [{ email: "x@example.test", role: "author" }, 400],
    [{ tenantId: TENANT, email: "x@example.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@example.test" }, 403],
  ] as const) {
    const app = load({ session });
    const res = await app.post(youtube);
    assert.equal(res.status, code, JSON.stringify(session));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual([app.slugReads, app.enqueues, app.afters], [[], [], []]);
  }
});

test("switched off, the answer is 403 with the plain message, for an author and an admin alike, and nothing is queued", async () => {
  for (const env of [{}, { AI_AUTHORING_TENANTS: "" }, { AI_AUTHORING_TENANTS: " , " }, { AI_AUTHORING_TENANTS: "tenant-b" }]) {
    for (const role of ["author", "admin"]) {
      const app = load({ env, session: { ...AUTHOR, role } });
      const res = await app.post(youtube);
      assert.equal(res.status, 403, JSON.stringify(env));
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.deepEqual(await res.json(), { error: "AI course drafting isn't turned on for this organisation." });
      assert.deepEqual([app.enqueues, app.afters, app.runs], [[], [], []]);
    }
  }
  // Off everywhere doesn't even look the tenant up.
  assert.deepEqual(load({ env: {} }).slugReads, []);
  const off = load({ env: { AI_AUTHORING_TENANTS: "" } });
  await off.post(youtube);
  assert.deepEqual(off.slugReads, []);
});

test("a body that isn't a source and options, or a source the job refuses, is 400 and queues nothing", async () => {
  const app = load();
  const badBody = "Choose a source (a YouTube link, a web page link, or pasted text with a title), a lesson count from 3 to 10, and quizzes on or off.";
  for (const body of [
    "not json",
    {},
    { source: { kind: "pdf", url: "https://example.test/a.pdf" } },
    { source: { kind: "youtube" } },
    { source: { kind: "youtube", url: VIDEO }, tenantId: OTHER },
    { source: { kind: "youtube", url: VIDEO, tenantId: OTHER } },
    { source: { kind: "youtube", url: VIDEO }, options: { lessonCount: 2 } },
    { source: { kind: "youtube", url: VIDEO }, options: { lessonCount: 11 } },
    { source: { kind: "youtube", url: VIDEO }, options: { lessonCount: 4.5 } },
    { source: { kind: "youtube", url: VIDEO }, options: { lessonCount: "5" } },
    { source: { kind: "youtube", url: VIDEO }, options: { quizzes: "yes" } },
    { source: { kind: "youtube", url: VIDEO }, options: { model: "claude-opus-4-7" } },
  ]) {
    const res = await app.post(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { error: badBody }, JSON.stringify(body));
  }
  for (const [body, message] of [
    [{ source: { kind: "youtube", url: "https://example.test/watch" } }, /^That is not a YouTube video address\.$/],
    [{ source: { kind: "url", url: "http://127.0.0.1/admin" } }, /./],
    [{ source: { kind: "url", url: "ftp://example.test/notes" } }, /./],
    [{ source: { kind: "url", url: `https://example.test/${"a".repeat(2100)}` } }, /the most is 2,048/],
    [{ source: { kind: "text", title: " ", text: "Chock the wheels." } }, /^Pasted text needs a title\.$/],
    [{ source: { kind: "text", title: "Notes", text: "x".repeat(200_001) } }, /the most is 200,000/],
  ] as const) {
    const res = await app.post(body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 120));
    const { error } = await res.json();
    assert.match(error, message);
    assert.notEqual(error, badBody);
  }
  assert.deepEqual([app.enqueues, app.afters], [[], []]);
});

test("a tenant with two jobs queued or running is refused with 429 and the worker kicked; another tenant's jobs and finished ones don't count", async () => {
  const full = load({ jobs: [{ status: "queued" }, { status: "running" }, { status: "completed" }] });
  const res = await full.post(youtube);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), {
    error: "Your organisation already has 2 AI drafts in progress, the most at once. Try again when one has finished.",
  });
  assert.equal(full.enqueues.length, 1);
  assert.deepEqual(plain(full.enqueues[0]!.limits), { maxActive: 2, maxPerMonth: 20 });
  assert.equal(full.jobs.length, 3);
  // The jobs holding the cap still get a worker pass, so they can't sit there.
  assert.deepEqual([full.afters.length, full.runs, full.kicks], [1, [], []]);
  await full.afters[0]!();
  assert.deepEqual(plain(full.kicks), [{ budgetMs: 200_000 }]);

  const room = load({ jobs: [
    { status: "running" }, { status: "failed" }, { status: "completed" },
    ...Array.from({ length: 5 }, () => ({ tenantId: OTHER, status: "queued" })),
  ] });
  assert.equal((await room.post(youtube)).status, 202);
});

test("a tenant that has started 20 jobs this calendar month is refused with 429, whatever became of them; last month's don't count", async () => {
  const spent = load({ jobs: Array.from({ length: 20 }, (_, i) => ({ status: i % 2 ? "failed" : "completed" })) });
  const res = await spent.post(youtube);
  assert.equal(res.status, 429);
  assert.deepEqual(await res.json(), {
    error: "Your organisation has started 20 AI drafts this month, the monthly limit. More can start from the 1st of next month (UTC).",
  });
  assert.deepEqual([spent.jobs.length, spent.afters.length, spent.runs], [20, 1, []]);

  const fresh = load({ jobs: [
    ...Array.from({ length: 19 }, () => ({ status: "completed" })),
    ...Array.from({ length: 30 }, () => ({ status: "completed", createdAt: LAST_MONTH })),
    ...Array.from({ length: 30 }, () => ({ tenantId: OTHER, status: "completed" })),
  ] });
  assert.equal((await fresh.post(youtube)).status, 202);
  assert.equal((await fresh.post(youtube)).status, 429);
});

test("an author's job is queued for the session's tenant, by the author, with their options; 202 with its id, then one worker pass", async () => {
  const app = load();
  const res = await app.post(youtube);
  assert.equal(res.status, 202);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ["ingestionId"]);
  assert.deepEqual(app.slugReads, [TENANT]);

  assert.equal(app.enqueues.length, 1);
  const { tenantId, input, limits } = app.enqueues[0]!;
  assert.equal(tenantId, TENANT);
  assert.deepEqual(plain(input), { createdBy: "author@example.test", sourceKind: "youtube", sourceRef: VIDEO, options: { lessonCount: 5, quizzes: false } });
  assert.deepEqual(plain(limits), { maxActive: 2, maxPerMonth: 20 });
  const row = app.jobs.find((j) => j.ingestionId === body.ingestionId)!;
  assert.deepEqual([row.tenantId, row.createdBy, JSON.parse(row.optionsJson)], [TENANT, "author@example.test", { lessonCount: 5, quizzes: false }]);
  assert.deepEqual(app.runs.map((r) => [r[0], r[1], r[4]]), [["lms-ai-authoring", "SUCCESS", `enqueue youtube tenant=${TENANT} ingestion=${body.ingestionId}`]]);

  assert.equal(app.kicks.length, 0, "the worker runs after the answer, not before");
  assert.equal(app.afters.length, 1);
  await app.afters[0]!();
  assert.deepEqual(plain(app.kicks), [{ budgetMs: 200_000 }]);
});

test("pasted text and a web page are queued as the job reads them; a web address naming a video becomes a YouTube source", async () => {
  const app = load({ session: { ...AUTHOR, role: "admin" } });
  assert.equal((await app.post({ source: { kind: "text", title: "  Hangar   notes ", text: "Chock the wheels.\r\n" } })).status, 202);
  assert.equal((await app.post({ source: { kind: "url", url: "https://youtu.be/abc123" }, options: { quizzes: true } })).status, 202);
  const [paste, video] = app.enqueues.map((e) => plain(e.input));
  assert.deepEqual(paste, { createdBy: "author@example.test", sourceKind: "text", sourceRef: "Hangar notes",
    options: { source: { title: "Hangar notes", text: "Chock the wheels." } } });
  assert.deepEqual(video, { createdBy: "author@example.test", sourceKind: "youtube", sourceRef: "https://youtu.be/abc123", options: { quizzes: true } });
});

test("the queued job reads back for its own tenant and is not found for another tenant's author", async () => {
  const app = load();
  const { ingestionId } = await (await app.post(youtube)).json();
  const own = await app.read(ingestionId);
  assert.equal(own.status, 200);
  assert.deepEqual([(await own.json()).ingestion.id], [ingestionId]);
  app.as({ tenantId: OTHER, email: "author@example.test", role: "author" });
  const other = await app.read(ingestionId);
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), { error: "Ingestion not found" });
});

test("a failed enqueue answers 500 without its detail; a failed worker pass is logged and never thrown", async () => {
  const app = load({ failEnqueue: true });
  const res = await app.post(youtube);
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "Something went wrong" });
  assert.deepEqual([app.afters.length, app.errors.map((e) => e[0])], [0, ["lms-ai-authoring"]]);

  const kick = load({ failKick: true });
  assert.equal((await kick.post(youtube)).status, 202);
  await kick.afters[0]!();
  assert.deepEqual(kick.errors.map((e) => [e[0], e[1], e[2]]), [["lms-ai-authoring", "kick: claim failed", "ERROR"]]);
});
