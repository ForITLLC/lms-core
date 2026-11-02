import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as completion from "./completion";
import * as scope from "./course-scope";
import * as assemble from "../drill/assemble";
import * as drillSchema from "../drill/schema";
import * as quiz from "../schema/quiz";

// Re-certification: opening a renewal clears Enrollment.CompletedAt for the new
// cycle. A reader asking "has this learner completed the course" must still
// count the earlier cycle, so it goes through lastCompletedAt.

const flat = (sql: string) => sql.replace(/\s+/g, " ");
const HELPER = flat(completion.lastCompletedAt("e"));
const FLAGGED = `CROSS APPLY (SELECT CASE WHEN ${HELPER} IS NOT NULL THEN 1 ELSE 0 END AS Completed) done`;
const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

function load(file: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(source(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(`Unmocked module: ${name}`); return modules[name]; } });
  return exports;
}

function capture(rows: (sql: string) => unknown[] = () => []) {
  const statements: string[] = [];
  const db = {
    query: async (sql: string, params: any) => { statements.push(flat(sql)); assert.equal(params.tenantId, "T"); return rows(sql); },
    queryOne: async () => null,
    execute: async () => 1,
  };
  return { statements, db };
}

function usesHelper(sql: string) {
  assert.ok(sql.includes(HELPER), `does not read lastCompletedAt: ${sql.slice(0, 200)}`);
  assert.doesNotMatch(sql, /\be\.CompletedAt IS NOT NULL\b/);
}

test("the last completion falls back to an unrevoked certificate from an earlier cycle in the enrolment's tenant", () => {
  assert.ok(HELPER.startsWith("COALESCE(e.CompletedAt, (SELECT MAX(prior.IssuedAt) FROM lms.Certificate prior WHERE "));
  for (const filter of ["prior.LearnerId = e.LearnerId", "prior.CourseId = e.CourseId", "prior.TenantId = e.TenantId",
    "prior.RevokedAt IS NULL", "prior.CycleNo < e.CycleNo"]) {
    assert.ok(HELPER.includes(filter), `missing ${filter}`);
  }
  const other = flat(completion.lastCompletedAt("x"));
  assert.ok(other.includes("prior.CycleNo < x.CycleNo") && other.includes("prior.TenantId = x.TenantId"));
  assert.doesNotMatch(other, /\be\./);
});

test("compliance rollups count a learner with an open renewal as completed", async () => {
  const { statements, db } = capture((sql) => sql.includes("TotalLearners") ? [{ MandatoryCompletions: 0 }] : []);
  const reporting = load("./reporting.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope });
  await reporting.getMandatoryCompletionSummary("T");
  await reporting.getComplianceTotals("T");
  const [perCourse, totals] = statements;
  usesHelper(perCourse!);
  assert.ok(perCourse!.includes(FLAGGED), "per-course Completed must flag rows before SUM (Msg 130)");
  assert.ok(perCourse!.includes("SUM(done.Completed) AS Completed"));
  usesHelper(totals!);
  assert.ok(totals!.includes(`AND ${HELPER} IS NOT NULL`), "MandatoryCompletions");
});

test("the learner directory counts renewals as completions and keeps last-seen across archived progress", async () => {
  const { statements, db } = capture();
  const learners = load("./learners.ts", { "@/lib/db": db, "@/lib/db/completion": completion });
  await learners.listLearnersForTenant("T");
  const sql = statements[0]!;
  usesHelper(sql);
  assert.ok(sql.includes(FLAGGED));
  assert.ok(sql.includes("SUM(done.Completed) AS Completions"));
  assert.match(sql, /SELECT MAX\(seen\.CompletedAt\) AS LastSeenAt FROM \(SELECT p\.CompletedAt FROM lms\.Progress p WHERE p\.LearnerId = l\.LearnerId UNION ALL SELECT h\.CompletedAt FROM lms\.ProgressHistory h WHERE h\.LearnerId = l\.LearnerId\) seen/);
  assert.match(sql, /WHERE e\.LearnerId = l\.LearnerId AND e\.TenantId = @tenantId/);
  assert.match(sql, /WHERE l\.TenantId = @tenantId/);
});

test("a learner's completions keep the earlier cycle while a renewal is open", async () => {
  const issued = new Date("2025-11-01T00:00:00Z");
  const { statements, db } = capture(() => [{ CourseId: "C", Slug: "dg", Title: "DG", CompletedAt: issued }]);
  const progress = load("./progress.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope, "@/lib/db/versions": {} });
  assert.deepEqual([...await progress.listCompletionsForLearner("T", "L")].map((r: any) => ({ ...r })),
    [{ course_id: "C", slug: "dg", title: "DG", completed_at: issued.toISOString() }]);
  const sql = statements[0]!;
  usesHelper(sql);
  assert.ok(sql.includes(`${HELPER} AS CompletedAt`));
  assert.ok(sql.includes(`AND ${HELPER} IS NOT NULL`));
  assert.match(sql, /WHERE e\.TenantId = @tenantId/);
  assert.match(sql, /ORDER BY CompletedAt DESC$/);
});

test("the course's learner status, behind the admin course page and the v1 progress read, marks an open renewal", async () => {
  const earlier = new Date("2025-11-01T00:00:00Z");
  const now = new Date("2026-10-20T00:00:00Z");
  const row = (CompletedAt: Date | null, CycleCompletedAt: Date | null) =>
    ({ LearnerId: "L", DisplayName: "A", Email: "a@example.test", AzureOid: null, Status: "active", EnrolledAt: earlier,
       CompletedAt, CycleCompletedAt, PinnedVersionNumber: 1, TotalBlocks: 4, DoneBlocks: 1 });
  const { statements, db } = capture(() => [row(earlier, null), row(now, now), row(null, null)]);
  const admin = load("./courseAdmin.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope });
  const learners = await admin.getCourseLearnerStatus("T", "C");
  assert.equal(JSON.stringify(learners.map((l: any) => [l.completedAt, l.renewing])),
    JSON.stringify([[earlier, true], [now, false], [null, false]]));
  const sql = statements[0]!;
  assert.ok(sql.includes(`e.CompletedAt AS CycleCompletedAt, ${HELPER} AS CompletedAt,`));
  assert.ok(!HELPER.includes("'"), "the helper sits inside sp_executesql's N'...' string");
  assert.match(sql, /WHERE e\.TenantId = @tenantId AND e\.CourseId = @courseId/);
  assert.match(source("../api/reads.ts"), /completed: learners\.filter\(\(l\) => l\.completedAt !== null\)\.length/);
  assert.match(source("../../app/admin/courses/[slug]/page.tsx"), /if \(row\.renewing\) \{[\s\S]{0,200}Renewing[\s\S]{0,100}\}\s*if \(row\.completedAt\)/);
});

test("drill draws new cards from a course finished in an earlier cycle", async () => {
  const { statements, db } = capture();
  const drill = load("./drill.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/schema/quiz": quiz, "@/lib/drill/assemble": assemble, "@/lib/drill/schema": drillSchema, "node:crypto": crypto });
  await drill.loadNewPool("T", "L");
  usesHelper(statements[0]!);
  assert.ok(statements[0]!.includes(`AND ${HELPER} IS NOT NULL`));
});

test("every changed reader imports the helper and keeps the per-cycle readers per-cycle", () => {
  for (const file of ["./reporting.ts", "./learners.ts", "./progress.ts", "./drill.ts", "./learning-summary.ts", "./courseAdmin.ts"]) {
    const s = source(file);
    assert.match(s, /import \{ lastCompletedAt \} from "@\/lib\/db\/completion";/, file);
    assert.match(s, /lastCompletedAt\("e"\)/, file);
    assert.doesNotMatch(flat(s), /\be\.CompletedAt IS NOT NULL\b/, file);
  }
  assert.match(flat(source("./progress.ts")), /WHERE LearnerId = @learnerId AND CourseId = @courseId AND CompletedAt IS NULL`/);
  assert.match(source("./dashboard.ts"), /CASE WHEN e\.CompletedAt IS NOT NULL THEN 1 ELSE 0 END AS CourseCompleted/);
});
