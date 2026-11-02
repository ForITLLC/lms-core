import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import * as draftOps from "@/lib/builder/draft-ops";
import * as fork from "@/lib/builder/fork";
import * as preview from "@/lib/builder/preview";
import * as scope from "@/lib/db/course-scope";
import * as draftSchema from "@/lib/schema/draft";
import * as quizSchema from "@/lib/schema/quiz";
import { isUniqueViolation, randomSlug, slugify } from "@/lib/db/course-slug";

// POST /api/author/courses/[courseId]/draft/grade: staff of the session's
// tenant grade a preview quiz with the learner grader and get the learner
// submit route's answer less its attempt id. It writes nothing.

const TENANT = "dddddddd-0000-0000-0000-00000000000a";
const COURSE = "dddddddd-0000-0000-0000-00000000000c";
const OTHER = "dddddddd-0000-0000-0000-0000000000ff";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const VERSION = "dddddddd-0000-0000-0000-0000000000aa";
const LESSON = "dddddddd-0000-0000-0000-000000000001";
const BLOCK = "dddddddd-0000-0000-0000-000000000002";
const QUIZ = "dddddddd-0000-0000-0000-000000000003";
const SECRET = "Prompt text that must never be logged";

const questions = [
  { kind: "mcq", promptMd: SECRET, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" },
  { kind: "multi", promptMd: "Both", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], correctChoiceIds: ["a", "c"] },
  { kind: "tf", promptMd: "True?", correctValue: true },
  { kind: "short", promptMd: "Why?", rubricMd: "Mentions FOD", maxScore: 5 },
  { kind: "confidence", promptMd: "Sure?", choices: [{ id: "x", label: "X" }, { id: "y", label: "Y" }], correctChoiceId: "x" },
];
const doc = draftSchema.DraftDoc.parse({
  meta: { title: "Ramp safety" },
  lessons: [{ key: "l1", title: "One", blocks: [
    { kind: "text", key: "t1", markdown: "Read this" },
    { kind: "quiz", key: "q1", passingScore: 70, questions },
  ] }],
});
const draftRow = (revision = 3) => ({ CourseId: COURSE, DraftId: DRAFT, Slug: "ramp-safety", Status: "draft", BaseVersionId: null, Revision: revision, DocJson: JSON.stringify(doc), UpdatedAt: new Date(0), UpdatedBy: "a" });

const RIGHT = ["b", ["c", "a"], true, "", "x"];
const WRONG = ["a", ["a"], false, "", "y"];
const HALF = ["b", ["a"], true, "", "y"];

type Session = { tenantId?: string; email: string; role?: string } | null;
interface Call { kind: string; sql: string; params: Record<string, unknown> }

function evaluate(path: URL, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  runInNewContext(code, {
    exports, Response, Date, JSON, Promise, Error, String, URL, Buffer, Math, Number,
    require: (id: string) => { if (!(id in modules)) throw new Error(`unexpected import ${id}`); return modules[id]; },
  });
  return exports;
}

const at = (path: string) => new URL(path, import.meta.url);

function fakeDb(handle: (sql: string, params: Record<string, unknown>) => unknown) {
  const calls: Call[] = [];
  const record = (kind: string) => async (sql: string, params: Record<string, unknown> = {}) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    calls.push({ kind, sql: flat, params });
    return handle(flat, params);
  };
  return { db: { query: record("query"), queryOne: record("queryOne"), execute: record("execute") }, calls };
}

// The tenant's database: its draft at a revision, and one published version
// holding the same quiz under its block id.
function tenantDatabase(opts: { revision?: number; draft?: boolean; fail?: boolean }) {
  return (sql: string, params: Record<string, unknown>) => {
    if (opts.fail) throw new Error("connection reset");
    const own = params.tenantId === TENANT && params.courseId === COURSE;
    if (sql.includes("FROM lms.CourseDraft d JOIN lms.Course c")) return own && opts.draft !== false ? draftRow(opts.revision) : null;
    if (sql.startsWith("SELECT c.Title")) {
      return own ? { Title: "Ramp safety", Description: "", Category: null, Tags: "[]", ScheduleKind: null, RecurrenceMonths: null, RequiresQuizPass: false, CurrentVersionId: VERSION.toUpperCase() } : null;
    }
    if (!own || params.versionId !== VERSION) return [];
    if (sql.includes("FROM lms.QuizQuestion qq")) return questions.map((q, i) => ({ QuizId: QUIZ, OrderIndex: i, PayloadJson: JSON.stringify(q) }));
    if (sql.includes("FROM lms.Quiz q")) return [{ QuizId: QUIZ, BlockId: BLOCK, PassingScore: 70 }];
    if (sql.includes("FROM lms.Block b")) return [{ BlockId: BLOCK, LessonId: LESSON, OrderIndex: 0, PayloadJson: JSON.stringify({ kind: "quiz", quizId: QUIZ }) }];
    if (sql.includes("FROM lms.Lesson l")) return [{ LessonId: LESSON, Title: "One", OrderIndex: 0, EstMinutes: null }];
    throw new Error(`unexpected statement ${sql}`);
  };
}

function quizzesModule(db: unknown) {
  return evaluate(at("../../../../lib/db/quizzes.ts"), { "node:crypto": crypto, "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/schema/quiz": quizSchema });
}

function load(session: Session = { tenantId: TENANT, email: "author@example.test", role: "author" }, opts: { revision?: number; draft?: boolean; fail?: boolean } = {}) {
  const logs: string[] = [];
  const { db, calls } = fakeDb(tenantDatabase(opts));
  const logging = { recordError: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); }, recordServiceRun: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); } };
  const gate = evaluate(at("../../../../lib/auth/staff-gate.ts"), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const drafts = evaluate(at("../../../../lib/db/course-drafts.ts"), {
    "node:crypto": crypto,
    "@/lib/db": db,
    "@/lib/db/course-slug": { slugify, isUniqueViolation, randomSlug, ensureUniqueSlug: async (_t: string, base: string) => base },
    "@/lib/builder/draft-ops": draftOps,
    "@/lib/builder/fork": fork,
    "@/lib/schema/draft": draftSchema,
  });
  const route = evaluate(at("./[courseId]/draft/grade/route.ts"), {
    zod: { z },
    "@/lib/auth/staff-gate": gate,
    "@/lib/db/course-drafts": drafts,
    "@/lib/builder/fork": fork,
    "@/lib/builder/preview": preview,
    "@/lib/db/quizzes": quizzesModule(db),
    "@/lib/schema/draft": draftSchema,
  });
  return { route, calls, logs };
}

const post = (body: unknown) =>
  new Request(`https://tenant.example/api/author/courses/${COURSE}/draft/grade`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const params = (courseId = COURSE) => ({ params: Promise.resolve({ courseId }) });
const draftBody = (responses: unknown[] = RIGHT, extra: Record<string, unknown> = {}) => ({ draftId: DRAFT, revision: 3, blockKey: "q1", responses, ...extra });
const versionBody = (responses: unknown[] = RIGHT) => ({ draftId: null, versionId: VERSION.toUpperCase(), blockKey: BLOCK, responses });

function assertNoWrites(calls: Call[]) {
  for (const call of calls) {
    assert.notEqual(call.kind, "execute", call.sql);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i, call.sql);
    assert.equal(call.params.tenantId, TENANT, call.sql);
  }
}

test("signed out is 401, no tenant 400, a learner 403, and none of them read the database", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@example.test", role: "author" }, 400],
    [{ tenantId: TENANT, email: "x@example.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@example.test" }, 403],
  ] as const) {
    for (const body of [draftBody(), versionBody()]) {
      const app = load(session);
      const res = await app.route.POST(post(body), params());
      assert.equal(res.status, status, JSON.stringify(session));
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(app.calls.length, 0);
    }
  }
});

test("authors and admins grade the draft: right answers pass, wrong ones fail, with nothing written", async () => {
  for (const role of ["author", "admin"]) {
    const app = load({ tenantId: TENANT, email: `${role}@example.test`, role });
    const right = await app.route.POST(post(draftBody(RIGHT)), params(COURSE.toUpperCase()));
    assert.equal(right.status, 200);
    assert.equal(right.headers.get("cache-control"), "no-store");
    assert.deepEqual(await right.json(), {
      score: 100, passingScore: 70, passed: true, correctCount: 4, autoGradableCount: 4,
      perQuestion: [{ orderIndex: 0, correct: true }, { orderIndex: 1, correct: true }, { orderIndex: 2, correct: true }, { orderIndex: 3, correct: null }, { orderIndex: 4, correct: true }],
    });
    const wrong = await (await app.route.POST(post(draftBody(WRONG)), params())).json();
    assert.equal(wrong.score, 0);
    assert.equal(wrong.passed, false);
    assert.deepEqual(wrong.perQuestion.map((p: { correct: boolean | null }) => p.correct), [false, false, false, null, false]);
    const half = await (await app.route.POST(post(draftBody(HALF)), params())).json();
    assert.deepEqual([half.score, half.passed, half.correctCount], [50, false, 2]);
    assert.ok(app.calls.length > 0);
    assertNoWrites(app.calls);
  }
});

test("draftId null grades that published version by its block id, read-only", async () => {
  const app = load(undefined, { draft: false });
  const res = await app.route.POST(post(versionBody(HALF)), params());
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual([body.score, body.passed, body.correctCount, body.autoGradableCount], [50, false, 2, 4]);
  assert.ok(app.calls.some((c) => c.sql.includes("FROM lms.QuizQuestion qq") && c.params.versionId === VERSION));
  assert.ok(!app.calls.some((c) => c.sql.includes("lms.CourseDraft")), "the published preview never reads the draft");
  assertNoWrites(app.calls);

  const elsewhere = await load().route.POST(post({ ...versionBody(), versionId: OTHER }), params());
  assert.equal(elsewhere.status, 404, "a version that isn't this course's holds no such quiz");
  assert.equal((await elsewhere.json()).code, "block_not_found");
});

test("another tenant's course, or a course id that isn't one, is 404", async () => {
  for (const body of [draftBody(), versionBody()]) {
    const other = load();
    const res = await other.route.POST(post(body), params(OTHER));
    assert.equal(res.status, 404);
    assertNoWrites(other.calls);
    const junk = load();
    assert.equal((await junk.route.POST(post(body), params("../../etc"))).status, 404);
    assert.equal(junk.calls.length, 0);
  }
});

test("a stale revision or a replaced draft is 409 draft_conflict; a draft that's gone is 404", async () => {
  for (const [opts, body] of [
    [{ revision: 4 }, draftBody()],
    [{ revision: 3 }, draftBody(RIGHT, { revision: 2 })],
    [{ revision: 3 }, draftBody(RIGHT, { draftId: "dddddddd-0000-0000-0000-0000000000ee" })],
  ] as const) {
    const app = load(undefined, opts);
    const res = await app.route.POST(post(body), params());
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal((await res.json()).code, "draft_conflict");
    assertNoWrites(app.calls);
  }
  const gone = await load(undefined, { draft: false }).route.POST(post(draftBody()), params());
  assert.equal(gone.status, 404);
  const upper = await load().route.POST(post(draftBody(RIGHT, { draftId: DRAFT.toUpperCase() })), params());
  assert.equal(upper.status, 200, "draft ids compare case-blind");
});

test("an unknown block key is 404 and a block that isn't a quiz is 422", async () => {
  const missing = await load().route.POST(post(draftBody(RIGHT, { blockKey: "nope" })), params());
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "block_not_found");
  const text = await load().route.POST(post(draftBody(RIGHT, { blockKey: "t1" })), params());
  assert.equal(text.status, 422);
  assert.equal((await text.json()).code, "not_a_quiz");
  const lesson = await load().route.POST(post(draftBody(RIGHT, { blockKey: "l1" })), params());
  assert.equal(lesson.status, 404);
});

test("a body that doesn't name one draft revision or one version is refused before any read", async () => {
  const app = load();
  for (const body of [
    "not json",
    {},
    { draftId: DRAFT, blockKey: "q1", responses: RIGHT },
    { ...draftBody(), revision: 0 },
    { ...draftBody(), responses: "b" },
    { ...draftBody(), responses: [{ id: "b" }] },
    { ...draftBody(), blockKey: "../q1" },
    { ...draftBody(), versionId: VERSION },
    { ...draftBody(), tenantId: OTHER },
    { draftId: null, blockKey: "q1", responses: RIGHT },
    { ...versionBody(), revision: 3 },
    { ...draftBody(), responses: new Array(draftSchema.DRAFT_LIMITS.questionsPerQuiz + 1).fill(null) },
  ]) {
    const res = await app.route.POST(post(body), params());
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((await res.json()).code, "invalid");
  }
  assert.equal(app.calls.length, 0);
});

test("the answer matches the learner submit route's for the same quiz and answers, less the attempt id", async () => {
  for (const responses of [RIGHT, WRONG, HALF, [], [null, null, null, null, null]]) {
    const { db, calls } = fakeDb(() => 1);
    const learnerQuizzes = quizzesModule(db);
    const learner = evaluate(at("../../learner/quiz/submit/route.ts"), {
      "next/server": { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } },
      "@/lib/get-session": { getSessionUser: async () => ({ tenantId: TENANT, email: "pilot@example.test", name: "Pilot" }) },
      "@/lib/db/progress": { resolveLearner: async () => ({ learnerId: "L-1" }), ensureEnrollment: async () => true },
      "@/lib/db/quizzes": {
        getQuizForGrading: async () => ({ quizId: QUIZ, courseId: COURSE, passingScore: 70, questions: questions.map((question, orderIndex) => ({ questionId: `Q${orderIndex}`, orderIndex, question })) }),
        gradeResponses: learnerQuizzes.gradeResponses,
        recordAttempt: learnerQuizzes.recordAttempt,
      },
      "@/lib/ai/grading/queue": { queueAnswerMarking: async () => 0 },
      "@/lib/ai/grading/kick": { kickGrading: async () => undefined },
      "@/lib/records/writers": { recordExamAttempt: async () => false },
    });
    const learnerRes = await learner.POST(new Request("https://tenant.example/api/learner/quiz/submit", { method: "POST", body: JSON.stringify({ courseId: COURSE, quizId: QUIZ, responses }) }));
    const { attemptId, ...learnerBody } = await learnerRes.json();
    assert.ok(attemptId, "the learner route recorded an attempt");
    assert.ok(calls.some((c) => c.kind === "execute" && c.sql.includes("INSERT INTO lms.QuizAttempt")), "known positive: the learner path writes");

    const app = load();
    const previewRes = await app.route.POST(post(draftBody(responses)), params());
    assert.equal(previewRes.status, 200);
    const previewBody = await previewRes.json();
    assert.deepEqual(previewBody, learnerBody, JSON.stringify(responses));
    assert.deepEqual(Object.keys(previewBody), Object.keys(learnerBody), "same fields in the same order");
    assertNoWrites(app.calls);
  }
});

test("an unexpected failure is logged by its message only, never the answers or the draft", async () => {
  const app = load(undefined, { fail: true });
  const res = await app.route.POST(post(draftBody(["SECRET-ANSWER"])), params());
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(app.logs.some((line) => line.includes("connection reset")), "known positive: the failure was logged");
  for (const line of app.logs) {
    for (const secret of [SECRET, "SECRET-ANSWER", "Mentions FOD", "correctChoiceId"]) assert.equal(line.includes(secret), false, line);
  }
  const ok = load();
  await ok.route.POST(post(draftBody()), params());
  assert.deepEqual(ok.logs, [], "a grade logs nothing on success");
});
