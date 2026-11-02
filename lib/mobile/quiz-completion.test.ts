import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as scope from "../db/course-scope";
import * as completionGate from "../completion-gate";

// Execute the real route with isolated services, without credentials or a SQL server.
function load(file: string, modules: Record<string, unknown>): Record<string, any> {
  const source = readFileSync(resolve(process.cwd(), file), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText;
  const exports = {};
  runInNewContext(js, { exports, require: (name: string) => {
    assert.ok(name in modules, `Unmocked service: ${name}`);
    return modules[name];
  } });
  return exports;
}

const next = { NextResponse: { json: (body: unknown, opts?: { status?: number }) => ({
  status: opts?.status ?? 200, body,
}) } };

function completionFixture(over: { submitted?: boolean; requiresPass?: boolean; passed?: boolean; accessible?: boolean; enrolled?: boolean; bestScore?: number | null;
  eligibleQuizzes?: Array<{ quizId: string; submitted: boolean }>;
  scoreQuizzes?: Array<{ quizId: string; bestScore: number | null; passingScore: number; passed: boolean }>;
} = {}) {
  const calls: string[] = [];
  const passed = over.passed ?? false;
  const progress = {
    resolveLearner: async () => ({ learnerId: "L", displayName: "Learner" }),
    ensureEnrollment: async () => { calls.push("enroll"); return over.enrolled ?? true; },
    markAllBlocksComplete: async () => { calls.push("mark"); },
    getCourseProgress: async () => ({ completed: true, totalBlocks: 3, completedBlocks: 3, pct: 100 }),
    completeEnrollment: async () => { calls.push("complete"); return true; },
  };
  const quizzes = {
    getCourseQuizGate: async () => { calls.push("gate"); return { totalQuizzes: 1,
      passedQuizzes: passed ? 1 : 0, passed,
      quizzes: over.scoreQuizzes ?? [{ quizId: "q", bestScore: over.bestScore !== undefined ? over.bestScore : (over.submitted ? 0 : null), passingScore: 80, passed }] }; },
    courseRequiresQuizPass: async () => over.requiresPass ?? false,
  };
  const finish = load("lib/db/course-finish.ts", {
    "@/lib/db": { queryOne: async () => ({ Pending: 0 }) },
    "@/lib/db/progress": progress,
    "@/lib/db/quizzes": quizzes,
    "@/lib/db/certificates": { issueCertificate: async () => { calls.push("certificate"); return { SerialNo: "CERT" }; } },
    "@/lib/records/writers": { recordCourseCompletion: async () => { calls.push("record"); return true; } },
  });
  const route = load("app/api/learner/complete/route.ts", {
    "next/server": next,
    "@/lib/get-session": { getSessionUser: async () => ({ tenantId: "T", email: "learner@test", name: "Learner" }) },
    "@/lib/db/course-completion": { getCourseCompletionState: async (...args: string[]) => {
      assert.deepEqual(args, ["T", "L", "C"]);
      calls.push("scope");
      return over.accessible === false ? null : { versionId: "V", courseCompleted: false,
        quizzes: over.eligibleQuizzes ?? [{ quizId: "q", submitted: over.submitted ?? false }] };
    } },
    "@/lib/db/progress": progress,
    "@/lib/db/quizzes": quizzes,
    "@/lib/db/course-finish": finish,
    "@/lib/completion-gate": completionGate,
  });
  return { calls, run: () => route.POST({ json: async () => ({ courseId: "C" }) }) };
}

test("optional pass policy still rejects a missing submission before enrollment or progress writes", async () => {
  const fixture = completionFixture({ requiresPass: false });
  const result = await fixture.run();
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "quiz_submission_required");
  assert.equal(result.body.error, "Submit every quiz before completing this course.");
  assert.deepEqual(fixture.calls, ["scope", "gate"]);
});

test("an inaccessible course returns 404 before reads or writes for that course", async () => {
  const fixture = completionFixture({ accessible: false });
  assert.equal((await fixture.run()).status, 404);
  assert.deepEqual(fixture.calls, ["scope"]);
});

test("a course the learner holds no seat on returns 404 before any progress or certificate write", async () => {
  const fixture = completionFixture({ submitted: true, enrolled: false });
  const result = await fixture.run();
  assert.equal(result.status, 404);
  assert.deepEqual(fixture.calls, ["scope", "gate", "enroll"]);
});

test("a failed submitted attempt may complete when a pass is optional", async () => {
  const fixture = completionFixture({ submitted: true, requiresPass: false, passed: false });
  const result = await fixture.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.certificate.serialNo, "CERT");
  assert.deepEqual(fixture.calls, ["scope", "gate", "enroll", "mark", "complete", "record", "certificate"]);
});

test("a failed submitted attempt remains incomplete when a pass is required", async () => {
  const fixture = completionFixture({ submitted: true, requiresPass: true, passed: false });
  const result = await fixture.run();
  assert.equal(result.body.certificate, null);
  assert.equal(result.body.quizGate.required, true);
  assert.equal(result.body.quizGate.passed, false);
  assert.deepEqual(fixture.calls, ["scope", "gate", "enroll", "mark"]);
});

test("a passing submitted attempt completes a pass-required course", async () => {
  const fixture = completionFixture({ submitted: true, requiresPass: true, passed: true });
  assert.equal((await fixture.run()).body.certificate.serialNo, "CERT");
  assert.ok(fixture.calls.includes("complete"));
});

test("submission state scopes tenant and pinned lesson/block version, and does not infer submission from score", async () => {
  let sql = "";
  const group = load("lib/db/quiz-questions.ts", {
    "@/lib/schema/quiz": { QuizQuestion: { safeParse: (q: any) => ({ success: q.kind === "tf", data: q }) } },
  });
  const helper = load("lib/db/course-completion.ts", {
    "@/lib/db/quiz-questions": group,
    "@/lib/db/course-scope": scope,
    "@/lib/db": { query: async (text: string, params: unknown) => {
      sql = text;
      assert.equal(JSON.stringify(params), JSON.stringify({ tenantId: "T", learnerId: "L", courseId: "C" }));
      return [
        { VersionId: "PINNED", CompletedAt: null, QuizId: "Q1", Submitted: 1, PayloadJson: '{"kind":"tf"}' },
        { VersionId: "PINNED", CompletedAt: null, QuizId: "Q2", Submitted: 0, PayloadJson: '{"kind":"tf"}' },
        { VersionId: "PINNED", CompletedAt: null, QuizId: "EMPTY", Submitted: 0, PayloadJson: null },
      ];
    } },
  });
  const state = await helper.getCourseCompletionState("T", "L", "C");
  assert.equal(state.courseCompleted, false);
  assert.equal(state.versionId, "PINNED");
  assert.equal(JSON.stringify(state.quizzes), JSON.stringify([
    { quizId: "q1", submitted: true }, { quizId: "q2", submitted: false },
  ]));
  for (const required of ["e.TenantId = @tenantId", "c.TenantId = @tenantId", "s.TenantId = @tenantId",
    "e.LearnerId = @learnerId", "l.VersionId = c.VersionId", "b.VersionId = c.VersionId",
    "a.LearnerId = @learnerId", "a.SubmittedAt IS NOT NULL",
    "(c.CycleStartedAt IS NULL OR a.SubmittedAt >= c.CycleStartedAt)"]) assert.ok(sql.includes(required), required);
  assert.equal(sql.includes("a.Score"), false);
});

test("mobile course state derives completion from current enrollment and defaults closed", () => {
  const mobile = load("lib/mobile/course.ts", {});
  const detail = { course: { CourseId: "C", Slug: "c", Title: "C" }, versionId: "V", lessons: [] };
  const progress = { completed: true, totalBlocks: 2, completedBlocks: 2, pct: 100 };
  const defaults = mobile.toMobileCourse(detail, [], progress);
  assert.equal(defaults.course_completed, false);
  assert.equal(JSON.stringify(defaults.submitted_quiz_ids), "[]");
  const actual = mobile.toMobileCourse(detail, [], progress, ["q1"], true);
  assert.equal(actual.course_completed, true);
  assert.equal(JSON.stringify(actual.submitted_quiz_ids), '["q1"]');
});

test("a historical null score still counts as a submitted attempt when passing is optional", async () => {
  const fixture = completionFixture({ submitted: true, requiresPass: false, bestScore: null });
  assert.equal((await fixture.run()).body.certificate.serialNo, "CERT");
});

function mobileFixture(stateVersion = "PINNED", accessible = true) {
  const calls: string[] = [];
  const mobile = load("lib/mobile/course.ts", {});
  const detail = { course: { CourseId: "C", Slug: "course", Title: "C" }, versionId: "PINNED", lessons: [] };
  const route = load("app/api/mobile/courses/[slug]/route.ts", {
    "next/server": next,
    "@/lib/mobile/learner": { requireMobileLearner: async () => ({ ok: true,
      session: { tenantId: "T" }, learner: { learnerId: "L" } }) },
    "@/lib/db/courses": { getCourseBySlug: async (tenantId: string, slug: string, audience: { learnerId: string }, pinned?: string) => {
      calls.push([tenantId, slug, `learner=${audience.learnerId}`, ...(pinned ? [pinned] : [])].join(":"));
      return accessible ? { ...detail, versionId: pinned ?? "CURRENT" } : null;
    } },
    "@/lib/db/progress": {
      getSeenBlockIds: async () => ["b-quiz"],
      getCourseProgress: async () => ({ completed: true, totalBlocks: 1, completedBlocks: 1, pct: 100 }),
    },
    "@/lib/db/renewal": { openRenewalIfDue: async (...args: string[]) => { calls.push(`renew:${args.join(":")}`); return null; } },
    "@/lib/db/versions": { resolveLearnerVersion: async () => "PINNED", ensureEnrollmentPinned: async () => {} },
    "@/lib/db/tenants": { getTenantContentTokens: async () => ({}) },
    "@/lib/tenant-tokens": { resolveCourseTokens: (d: unknown) => d },
    "@/lib/db/course-completion": { getCourseCompletionState: async (...args: string[]) => {
      assert.deepEqual(args, ["T", "L", "C"]);
      calls.push("state");
      return { versionId: stateVersion, courseCompleted: false,
        quizzes: [{ quizId: "q1", submitted: true }, { quizId: "q2", submitted: false }] };
    } },
    "@/lib/mobile/course": mobile,
  });
  return { calls, run: () => route.GET({}, { params: Promise.resolve({ slug: "course" }) }) };
}

test("mobile GET keeps pinned-course submissions separate from all-seen progress", async () => {
  const fixture = mobileFixture();
  const result = await fixture.run();
  assert.equal(result.status, 200);
  assert.equal(result.body.course.version_id, "PINNED");
  assert.equal(JSON.stringify(result.body.submitted_quiz_ids), '["q1"]');
  assert.equal(result.body.course_completed, false);
  assert.equal(result.body.progress.completed, true);
  assert.deepEqual(fixture.calls, ["T:course:learner=L", "renew:T:L:C", "T:course:learner=L:PINNED", "state"]);
});

test("mobile GET rejects version races instead of disclosing a different version's submissions", async () => {
  assert.equal((await mobileFixture("OTHER").run()).status, 409);
});

test("mobile GET never reads attempt state for a course outside tenant scope", async () => {
  const fixture = mobileFixture("PINNED", false);
  assert.equal((await fixture.run()).status, 404);
  assert.deepEqual(fixture.calls, ["T:course:learner=L"]);
});

test("a pass-required course containing only empty quizzes can complete", async () => {
  const fixture = completionFixture({ requiresPass: true, eligibleQuizzes: [],
    scoreQuizzes: [{ quizId: "empty", bestScore: null, passingScore: 80, passed: false }] });
  const result = await fixture.run();
  assert.equal(result.body.certificate.serialNo, "CERT");
  assert.equal(result.body.quizGate.totalQuizzes, 0);
  assert.equal(result.body.quizGate.passed, true);
});

test("empty and non-pinned score rows cannot block a submitted eligible quiz", async () => {
  const fixture = completionFixture({ requiresPass: true,
    eligibleQuizzes: [{ quizId: "Q", submitted: true }],
    scoreQuizzes: [
      { quizId: "q", bestScore: 100, passingScore: 80, passed: true },
      { quizId: "empty", bestScore: null, passingScore: 80, passed: false },
      { quizId: "other-version", bestScore: null, passingScore: 80, passed: false },
    ] });
  const result = await fixture.run();
  assert.equal(result.body.certificate.serialNo, "CERT");
  assert.equal(result.body.quizGate.totalQuizzes, 1);
  assert.equal(result.body.quizGate.passedQuizzes, 1);
  assert.equal(result.body.quizGate.quizzes.length, 1);
});

test("a missing eligible score row fails closed when passing is required", async () => {
  const fixture = completionFixture({ requiresPass: true,
    eligibleQuizzes: [{ quizId: "q", submitted: true }, { quizId: "missing", submitted: true }],
    scoreQuizzes: [{ quizId: "Q", bestScore: 100, passingScore: 80, passed: true }] });
  const result = await fixture.run();
  assert.equal(result.body.certificate, null);
  assert.equal(result.body.quizGate.passed, false);
  assert.equal(result.body.quizGate.totalQuizzes, 2);
  assert.equal(result.body.quizGate.passedQuizzes, 1);
  assert.equal(fixture.calls.includes("complete"), false);
});
