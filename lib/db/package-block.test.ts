import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as blocks from "../schema/blocks";
import * as completion from "./completion";
import * as scope from "./course-scope";
import * as completionGate from "../completion-gate";

// SCORM / cmi5 slice 1 (docs/plans/2026-10-28-scorm-cmi5-import.md §2.4, §4.5): the package kind
// survives the course read, and only a satisfied launchable may write its lms.Progress row, so the
// beacon, the mark-all MERGE and the complete route (web and iPhone) never mark it done.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(`Unmocked module: ${name}`); return modules[name]; } });
  return exports;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function fakeDb(answer: (sql: string, params: Record<string, unknown>) => unknown = () => undefined) {
  const calls: Call[] = [];
  const writes: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql: flat(sql), params: { ...params } });
    return answer(flat(sql), params);
  };
  return {
    calls,
    writes,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? [],
      queryOne: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? null,
      execute: async (sql: string, params?: Record<string, unknown>) => {
        writes.push({ sql: flat(sql), params: { ...params } });
        return record(sql, params) ?? 1;
      },
    },
  };
}

const LAUNCHABLE = "0a000002-0000-4000-8000-000000000002";
const PACKAGE = { kind: "package", launchableId: LAUNCHABLE, title: "Golf: basic runtime calls", standard: "scorm2004" };

test("the package kind needs a launchable uuid, a title and a known standard, and keeps nothing else", () => {
  for (const standard of ["scorm12", "scorm2004", "cmi5"]) {
    assert.equal(blocks.Block.safeParse({ ...PACKAGE, standard }).success, true, standard);
  }
  const withExtras = blocks.Block.safeParse({ ...PACKAGE, url: "https://content.test/index.html?token=t", launchPath: "index.html" });
  assert.ok(withExtras.success);
  assert.deepEqual(Object.keys(withExtras.data).sort(), ["kind", "launchableId", "standard", "title"]);

  for (const bad of [
    { ...PACKAGE, launchableId: "launchable-1" },
    { ...PACKAGE, standard: "aicc" },
    { ...PACKAGE, standard: undefined },
    { ...PACKAGE, title: 7 },
    { kind: "package", launchableId: LAUNCHABLE, standard: "cmi5" },
  ]) {
    assert.equal(blocks.Block.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("getCourseBySlug keeps a package block beside the native ones", async () => {
  const { db } = fakeDb((sql) => {
    if (sql.includes("SELECT TOP 1")) {
      return {
        CourseId: "C", Title: "Golf", Slug: "golf", Description: null, Status: "published", Category: null, Tags: null,
        UpdatedAt: new Date(0), OwnerUserId: null, OwnerGroupId: null, OwnerGroupName: null, OwnerName: null,
        IsCatalog: false, IsCatalogSubscribed: false, CurrentVersionId: "V",
      };
    }
    if (sql.startsWith("SELECT LessonId, Title")) return [{ LessonId: "L1", Title: "One", OrderIndex: 1, EstMinutes: null }];
    if (sql.startsWith("SELECT BlockId, LessonId")) {
      return [
        { BlockId: "B-TEXT", LessonId: "L1", OrderIndex: 1, PayloadJson: JSON.stringify({ kind: "text", markdown: "Intro" }) },
        { BlockId: "B-PKG", LessonId: "L1", OrderIndex: 2, PayloadJson: JSON.stringify({ ...PACKAGE, url: "https://content.test/x" }) },
      ];
    }
    return undefined;
  });
  const courses = load("./courses.ts", {
    "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/schema/blocks": blocks,
    "@/lib/schema/quiz": { QuizQuestion: { safeParse: () => ({ success: false }) } },
    "@/lib/db/quiz-questions": { groupQuizQuestions: () => new Map(), questionsForQuiz: () => [] },
  });
  const detail = await courses.getCourseBySlug("T", "golf", { learnerId: "L" });
  assert.deepEqual(plain(detail.lessons[0].blocks), [
    { kind: "text", markdown: "Intro", blockId: "B-TEXT" },
    { ...PACKAGE, blockId: "B-PKG" },
  ]);
});

function progressModule(answer: (sql: string, params: Record<string, unknown>) => unknown = () => undefined) {
  const fake = fakeDb(answer);
  const progress = load("./progress.ts", {
    "@/lib/db": fake.db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/db/versions": { resolveLearnerVersion: async () => "V", ensureEnrollmentPinned: async () => {} },
  });
  return { ...fake, progress };
}

test("markAllBlocksComplete leaves package blocks out of the MERGE source", async () => {
  const { progress, writes } = progressModule();
  await progress.markAllBlocksComplete("L", "C");
  assert.equal(writes.length, 1);
  const sql = writes[0]!.sql;
  assert.ok(sql.startsWith("MERGE lms.Progress AS target"));
  const source = sql.slice(sql.indexOf("USING"), sql.indexOf(") AS src"));
  assert.ok(source.includes("AND b.Kind <> 'package'"), source);
  assert.deepEqual(writes[0]!.params, { learnerId: "L", courseId: "C" });
});

test("recordBlockProgress only writes a block that is not a package block, and says when it wrote nothing", async () => {
  const wrote = progressModule(() => 1);
  assert.equal(await wrote.progress.recordBlockProgress("L", "B", 5), true);
  const sql = wrote.writes[0]!.sql;
  assert.ok(sql.includes("USING (SELECT @learnerId AS LearnerId, b.BlockId FROM lms.Block b WHERE b.BlockId = @blockId AND b.Kind <> 'package') AS src"), sql);
  assert.ok(sql.includes("VALUES (@learnerId, src.BlockId, @seconds)"), sql);

  const refused = progressModule(() => 0);
  assert.equal(await refused.progress.recordBlockProgress("L", "B-PKG", 5), false);
});

const nextServer = { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } };
const signedIn = { getSessionUser: async () => ({ tenantId: "T", email: "pilot@example.test", name: "Pilot" }) };

function beacon(kind: string | null) {
  const steps: string[] = [];
  const route = load("../../app/api/learner/progress/route.ts", { "next/server": nextServer, "@/lib/get-session": signedIn,
    "@/lib/db/progress": {
      courseBlockKind: async (...args: string[]) => { steps.push(`kind:${args.join(":")}`); return kind; },
      resolveLearner: async () => { steps.push("learner"); return { learnerId: "L", displayName: "Pilot" }; },
      ensureEnrollment: async () => { steps.push("enroll"); return true; },
      recordBlockProgress: async () => { steps.push("record"); return true; },
      getCourseProgress: async () => ({ completed: false }),
    } });
  const mobile = load("../../app/api/mobile/progress/route.ts", { "@/app/api/learner/progress/route": route });
  return { steps, route, mobile };
}

test("the progress beacon refuses a package block with a 400, on the web and from the iPhone app, before any write", async () => {
  const { steps, route, mobile } = beacon("package");
  assert.equal(mobile.POST, route.POST);
  for (const handler of [route.POST, mobile.POST]) {
    const res = await handler({ json: async () => ({ courseId: "C", blockId: "B-PKG", seconds: 30 }) });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "package_block");
  }
  assert.deepEqual(steps, ["kind:B-PKG:C", "kind:B-PKG:C"]);

  const forged = beacon(null);
  assert.equal((await forged.route.POST({ json: async () => ({ courseId: "C", blockId: "B-OTHER" }) })).status, 400);
  assert.deepEqual(forged.steps, ["kind:B-OTHER:C"]);

  const native = beacon("text");
  assert.equal((await native.route.POST({ json: async () => ({ courseId: "C", blockId: "B-TEXT" }) })).status, 200);
  assert.deepEqual(native.steps, ["kind:B-TEXT:C", "learner", "enroll", "record"]);
});

function completing(pendingPackages: number) {
  const steps: string[] = [];
  const fake = fakeDb((sql) => {
    if (sql.startsWith("SELECT LearnerId, DisplayName FROM lms.Learner")) return { LearnerId: "L", DisplayName: "Pilot" };
    if (sql.includes("AS Hit")) return { Hit: 1 };
    if (sql.includes("AS Pending")) return { Pending: pendingPackages };
    if (sql.includes("AS TotalBlocks")) return { TotalBlocks: 3, DoneBlocks: 3 };
    return undefined;
  });
  const progress = load("./progress.ts", {
    "@/lib/db": fake.db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/db/versions": { resolveLearnerVersion: async () => "V", ensureEnrollmentPinned: async () => { steps.push("pin"); } },
  });
  const quizzes = {
    getCourseQuizGate: async () => ({ totalQuizzes: 0, passedQuizzes: 0, passed: true, quizzes: [] }),
    courseRequiresQuizPass: async () => false,
  };
  const certificates = { issueCertificate: async (...args: string[]) => { steps.push(`certificate:${args.join(":")}`); return { SerialNo: "CERT" }; } };
  const records = { recordCourseCompletion: async (...args: string[]) => { steps.push(`record:${args.join(":")}`); return true; } };
  const finish = load("./course-finish.ts", {
    "@/lib/db": fake.db, "@/lib/db/progress": progress, "@/lib/db/quizzes": quizzes, "@/lib/db/certificates": certificates,
    "@/lib/records/writers": records,
  });
  const route = load("../../app/api/learner/complete/route.ts", {
    "next/server": nextServer, "@/lib/get-session": signedIn, "@/lib/db/progress": progress, "@/lib/db/quizzes": quizzes,
    "@/lib/db/course-finish": finish, "@/lib/completion-gate": completionGate,
    "@/lib/db/course-completion": { getCourseCompletionState: async () => ({ versionId: "V", courseCompleted: false, quizzes: [] }) },
  });
  const mobile = load("../../app/api/mobile/complete/route.ts", { "@/app/api/learner/complete/route": route });
  const run = (handler: (req: unknown) => Promise<any>) => handler({ json: async () => ({ courseId: "C" }) });
  return { ...fake, steps, route, mobile, run };
}

test("complete answers 409 package_incomplete while a package block has no progress, on the web and the iPhone app", async () => {
  const fixture = completing(1);
  assert.equal(fixture.mobile.POST, fixture.route.POST);
  for (const handler of [fixture.route.POST, fixture.mobile.POST]) {
    const res = await fixture.run(handler);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "package_incomplete");
  }
  assert.equal(fixture.writes.some((w) => w.sql.includes("lms.Progress")), false, "a block was marked done");
  assert.equal(fixture.writes.some((w) => w.sql.startsWith("UPDATE lms.Enrollment")), false, "the enrollment was completed");
  assert.equal(fixture.steps.some((s) => s.startsWith("certificate")), false, "a certificate was issued");
  assert.equal(fixture.steps.some((s) => s.startsWith("record")), false, "a training record was written");

  const pending = fixture.calls.find((c) => c.sql.includes("AS Pending"))!;
  assert.deepEqual(pending.params, { tenantId: "T", learnerId: "L", courseId: "C" });
  for (const required of [
    "e.LearnerId = @learnerId AND e.TenantId = @tenantId",
    "l.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)",
    "b.VersionId = COALESCE(e.VersionId, c.CurrentVersionId)",
    "c.CourseId = @courseId",
    "b.Kind = 'package'",
    "NOT EXISTS (SELECT 1 FROM lms.Progress p WHERE p.LearnerId = @learnerId AND p.BlockId = b.BlockId)",
  ]) assert.ok(pending.sql.includes(required), required);
});

test("complete finishes the course once every package block has progress", async () => {
  const fixture = completing(0);
  const res = await fixture.run(fixture.mobile.POST);
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.body), ["progress", "certificate", "quizGate"]);
  assert.equal(res.body.certificate.serialNo, "CERT");
  assert.equal(res.body.quizGate, null);
  const marked = fixture.writes.find((w) => w.sql.startsWith("MERGE lms.Progress"));
  assert.ok(marked && marked.sql.includes("AND b.Kind <> 'package'"));
  assert.ok(fixture.writes.some((w) => w.sql.startsWith("UPDATE lms.Enrollment SET Status = 'completed'")));
  assert.deepEqual(fixture.steps, ["pin", "record:T:L:C", "certificate:T:L:Pilot:C"]);
});
