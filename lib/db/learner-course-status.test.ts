import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as scope from "./course-scope";

// Bug 2C58C8DF: a learner could open a draft or archived course by typing its
// slug, because the learner scope checked the tenant, subscription and seat but
// never c.Status. The rule: a published course opens; an archived one opens only
// to a learner already enrolled in it; a draft never opens to a learner.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const source = (file: string) => flat(readFileSync(new URL(file, import.meta.url), "utf8"));

const OPENABLE = (learner: string) =>
  "(c.Status = 'published' OR (c.Status = 'archived' AND EXISTS (SELECT 1 FROM lms.Enrollment opened " +
  `WHERE opened.TenantId = @tenantId AND opened.LearnerId = ${learner} AND opened.CourseId = c.CourseId)))`;

function capture() {
  const calls: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => { calls.push({ sql: flat(sql), params: { ...params } }); };
  return {
    calls,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => { record(sql, params); return []; },
      queryOne: async (sql: string, params?: Record<string, unknown>) => { record(sql, params); return null; },
      execute: async (sql: string, params?: Record<string, unknown>) => { record(sql, params); return 1; },
    },
  };
}

const coursesModule = (db: unknown) => load("./courses.ts", {
  "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/schema/blocks": {},
  "@/lib/schema/quiz": { QuizQuestion: { safeParse: () => ({ success: false }) } },
  "@/lib/db/quiz-questions": { groupQuizQuestions: () => new Map(), questionsForQuiz: () => [] },
});

test("the learner scope opens a published course, an archived one only to its enrolled learner, and never a draft", () => {
  for (const learner of ["@learnerId", "l.LearnerId"]) {
    const sql = flat(scope.learnerAccessibleScope(learner));
    assert.ok(sql.startsWith("((c.TenantId = @tenantId OR "), sql.slice(0, 80));
    assert.ok(sql.endsWith(`) AND ${OPENABLE(learner)})`), "the status rule applies to every access path, own, subscribed and seat alike");
    assert.doesNotMatch(sql, /'draft'/);
  }
  assert.doesNotMatch(flat(scope.TENANT_VISIBLE_SCOPE), /c\.Status/, "operators and authors still see drafts");
});

test("getCourseBySlug applies the status rule for a learner and not for an operator", async () => {
  const { db, calls } = capture();
  const courses = coursesModule(db);
  assert.equal(await courses.getCourseBySlug("T-1", "draft-course", { learnerId: "L-1" }), null);
  assert.equal(await courses.getCourseBySlug("T-1", "draft-course", "operator"), null);
  const [learner, operator] = calls;
  assert.ok(learner!.sql.includes(`WHERE c.Slug = @slug AND ${flat(scope.learnerAccessibleScope())}`), learner!.sql);
  assert.ok(learner!.sql.includes(OPENABLE("@learnerId")), "a draft slug finds no row for a learner");
  assert.deepEqual(learner!.params, { tenantId: "T-1", slug: "draft-course", learnerId: "L-1" });
  assert.doesNotMatch(operator!.sql, /c\.Status = 'published'/);
});

const nextServer = { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } };

test("the iPhone app's course route answers 404 for a course the learner may not open, before pinning or renewing", async () => {
  const { db, calls } = capture();
  const steps: string[] = [];
  const step = (name: string) => async () => { steps.push(name); };
  const route = load("../../app/api/mobile/courses/[slug]/route.ts", {
    "next/server": nextServer,
    "@/lib/mobile/learner": { requireMobileLearner: async () => ({ ok: true, session: { tenantId: "T-1" }, learner: { learnerId: "L-1" } }) },
    "@/lib/db/courses": coursesModule(db),
    "@/lib/db/progress": { getCourseProgress: step("progress"), getSeenBlockIds: step("seen") },
    "@/lib/db/versions": { ensureEnrollmentPinned: step("pin"), resolveLearnerVersion: step("resolve") },
    "@/lib/db/renewal": { openRenewalIfDue: step("renew") },
    "@/lib/db/tenants": { getTenantContentTokens: step("tokens") },
    "@/lib/tenant-tokens": { resolveCourseTokens: step("resolveTokens") },
    "@/lib/db/course-completion": { getCourseCompletionState: step("completion") },
    "@/lib/mobile/course": { toMobileCourse: step("toMobile") },
  });
  const res = await route.GET(new Request("https://t.example/api/mobile/courses/draft-course"), { params: Promise.resolve({ slug: "draft-course" }) });
  assert.equal(res.status, 404);
  assert.equal((res.body as { error: string }).error, "not_found");
  assert.deepEqual(steps, []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.sql.includes(OPENABLE("@learnerId")), calls[0]!.sql);
});

test("the tutor answers 404 for a course the learner may not open, before calling the model", async () => {
  const { db, calls } = capture();
  const steps: string[] = [];
  const route = load("../../app/api/ai/chat/route.ts", {
    "next/server": nextServer,
    "@/lib/logging": { recordError: async () => {}, recordServiceRun: async () => {} },
    "@/lib/ai/claude": { getClaude: () => { steps.push("claude"); }, MODELS: {}, buildCachedSystem: () => [] },
    "@/lib/ai/context": { courseCorpus: () => "", TutorRequest: { safeParse: (data: unknown) => ({ success: true, data }) }, tutorQuestion: () => "" },
    "@/lib/ai/rate-limit": { tutorLimiter: { take: () => 0 } },
    "@/lib/get-session": { requireSessionUser: async () => ({ tenantId: "T-1", email: "pilot@example.test", name: "Pilot", azureOid: "oid-1" }) },
    "@/lib/db/courses": coursesModule(db),
    "@/lib/db/progress": { resolveLearner: async () => ({ learnerId: "L-1" }) },
    "@/lib/db/versions": { resolveLearnerVersion: async () => { steps.push("resolve"); return null; } },
    "@/lib/db/tenants": { getTenantContentTokens: async () => { steps.push("tokens"); return {}; } },
    "@/lib/tenant-tokens": { resolveCourseTokens: (x: unknown) => x },
    "@/lib/mobile/course": { stripBlock: (x: unknown) => x },
  });
  const req = { json: async () => ({ message: "What is on the test?", courseSlug: "draft-course" }) } as unknown as Request;
  const res = await route.POST(req);
  assert.equal(res.status, 404);
  assert.deepEqual(steps, []);
  assert.equal(calls.length, 1);
  assert.ok(calls[0]!.sql.includes(OPENABLE("@learnerId")), calls[0]!.sql);
});

test("the /learn course page loads the course in the learner's scope and 404s before pinning or renewing", () => {
  const page = source("../../app/learn/[slug]/page.tsx");
  assert.ok(page.includes("const preview = await getCourseBySlug(tenantId, slug, { learnerId: learner.learnerId }); if (!preview) notFound();"), "learner scope, then notFound");
  assert.ok(page.indexOf("if (!preview) notFound();") < page.indexOf("openRenewalIfDue("), "nothing is renewed for a course the learner may not open");
  assert.ok(page.indexOf("if (!preview) notFound();") < page.indexOf("ensureEnrollmentPinned("), "nothing is pinned for a course the learner may not open");
});
