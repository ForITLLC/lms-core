import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as schedule from "./schedule";

// Re-certification (docs/plans/2026-10-27-recertification-design.md): a
// completed recurrent course reopens as the next cycle when its current
// cycle's certificate is inside the renewal window and a pass now would earn a
// later expiry.

function load(db: Record<string, unknown>) {
  const source = readFileSync(new URL("./renewal.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const modules: Record<string, unknown> = { "@/lib/db": db, "@/lib/db/schedule": schedule };
  runInNewContext(code, { exports, Date, Math, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ");
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

function fixture(held: Record<string, unknown> | null, opened = 1) {
  const calls: Array<{ sql: string; params: any }> = [];
  const db = {
    queryOne: async (sql: string, params: any) => {
      calls.push({ sql: flat(sql), params });
      return calls.length === 1 ? held : { Opened: opened };
    },
  };
  return { calls, renewal: load(db) };
}

const annualDecember = { ScheduleKind: "annual", RecurrenceMonths: null, IssuedAt: d("2026-12-15"), ExpiresAt: d("2027-01-31") };
const annualMarch = { ScheduleKind: "annual", RecurrenceMonths: null, IssuedAt: d("2026-03-01"), ExpiresAt: d("2027-01-31") };
const twoYear = { ScheduleKind: "recurring", RecurrenceMonths: 24, IssuedAt: d("2024-11-01"), ExpiresAt: d("2026-11-01") };
const monthly = { ScheduleKind: "recurring", RecurrenceMonths: 1, IssuedAt: d("2026-10-01"), ExpiresAt: d("2026-11-01") };

test("an annual course finished in December does not reopen before a new pass would count", () => {
  const { renewal } = fixture(null);
  for (const day of ["2026-12-15", "2026-12-31", "2027-01-05"]) {
    assert.equal(renewal.renewalDue(annualDecember, d(day)), false, day);
  }
  assert.equal(renewal.renewalDue(annualDecember, d("2027-01-08")), true);
  assert.equal(renewal.renewalDue(annualDecember, d("2027-03-01")), true, "expired");
});

test("an annual certificate opens its renewal from Jan 1, when a pass earns next year's expiry", () => {
  const { renewal } = fixture(null);
  assert.equal(renewal.renewalDue(annualMarch, d("2026-11-15")), false);
  assert.equal(renewal.renewalDue(annualMarch, d("2026-12-10")), false, "a December pass would expire on the same Jan 31");
  assert.equal(renewal.renewalDue(annualMarch, d("2027-01-02")), true);
});

test("a recurring certificate opens 60 days before expiry, or at half its validity when that is later", () => {
  const { renewal } = fixture(null);
  assert.equal(renewal.renewalDue(twoYear, d("2026-08-01")), false);
  assert.equal(renewal.renewalDue(twoYear, d("2026-09-01")), false);
  assert.equal(renewal.renewalDue(twoYear, d("2026-09-03")), true);
  assert.equal(renewal.renewalDue(twoYear, d("2027-01-01")), true, "expired");
  assert.equal(renewal.renewalDue(monthly, d("2026-10-02")), false, "a one-month certificate never reopens the day it is issued");
  assert.equal(renewal.renewalDue(monthly, d("2026-10-16")), false);
  assert.equal(renewal.renewalDue(monthly, d("2026-10-17")), true);
});

test("only the current cycle's live certificate on a completed, scheduled course can make a renewal due", async () => {
  const { calls, renewal } = fixture(null);
  assert.equal(await renewal.openRenewalIfDue("T", "L", "C", d("2027-01-08")), null);
  assert.equal(calls.length, 1, "no renewal is due, so nothing is written");
  const [{ sql, params }] = calls as [{ sql: string; params: any }];
  assert.equal(JSON.stringify(params), JSON.stringify({ tenantId: "T", learnerId: "L", courseId: "C" }));
  for (const rule of [
    "e.TenantId = @tenantId", "e.LearnerId = @learnerId", "e.CourseId = @courseId",
    "e.CompletedAt IS NOT NULL",
    "c.ScheduleKind IS NOT NULL",
    "cert.TenantId = @tenantId", "cert.RevokedAt IS NULL",
    "ORDER BY cert.CycleNo DESC",
    "latest.CycleNo = e.CycleNo",
    "latest.ExpiresAt IS NOT NULL",
  ]) assert.ok(sql.includes(rule), rule);
  assert.match(sql, /CROSS APPLY \( SELECT TOP 1 cert\.IssuedAt, cert\.ExpiresAt, cert\.CycleNo/);
});

test("a held certificate outside its window writes nothing", async () => {
  const { calls, renewal } = fixture({ ...annualDecember, CycleNo: 1 });
  assert.equal(await renewal.openRenewalIfDue("T", "L", "C", d("2026-12-20")), null);
  assert.equal(calls.length, 1);
});

test("opening a cycle advances the enrolment once and archives the finished cycle's progress before clearing it", async () => {
  const { calls, renewal } = fixture({ ...twoYear, CycleNo: 2 });
  assert.equal(await renewal.openRenewalIfDue("T", "L", "C", d("2026-10-01")), 3);
  const tx = calls[1]!;
  assert.equal(JSON.stringify(tx.params), JSON.stringify({ tenantId: "T", learnerId: "L", courseId: "C", cycleNo: 2 }));
  const s = tx.sql;
  assert.match(s, /^\s*SET XACT_ABORT ON; BEGIN TRANSACTION;/);
  assert.match(s, /UPDATE e SET CycleNo = e\.CycleNo \+ 1, CycleStartedAt = SYSUTCDATETIME\(\), CompletedAt = NULL, Status = 'active'/);
  assert.match(s, /WHERE e\.TenantId = @tenantId AND e\.LearnerId = @learnerId AND e\.CourseId = @courseId AND e\.CycleNo = @cycleNo AND e\.CompletedAt IS NOT NULL;/,
    "the update is guarded on the cycle it was read at");
  assert.match(s, /a\.Status = 'active' AND a\.AssignedAt > e\.CompletedAt ORDER BY a\.AssignedAt DESC\), \(SELECT ent\.VersionId FROM lms\.CourseAssignment a JOIN lms\.Entitlement ent ON ent\.EntitlementId = a\.EntitlementId AND ent\.TenantId = a\.TenantId WHERE a\.TenantId = @tenantId AND a\.LearnerId = @learnerId AND a\.CourseId = @courseId AND a\.Status = 'active'\), \(SELECT c\.CurrentVersionId/,
    "an assignment made after the finished cycle pins the renewal; then a marketplace seat's entitlement version; otherwise the current version");
  const guard = s.indexOf("IF @@ROWCOUNT = 1");
  const archive = s.indexOf("INSERT INTO lms.ProgressHistory (LearnerId, BlockId, CycleNo, CompletedAt, Seconds) SELECT p.LearnerId, p.BlockId, @cycleNo,");
  const clear = s.indexOf("DELETE p FROM lms.Progress p");
  assert.ok(guard > 0 && guard < archive && archive < clear, `order: guard ${guard}, archive ${archive}, delete ${clear}`);
  for (const part of [archive, clear]) {
    assert.ok(s.slice(part, part + 400).includes("WHERE p.LearnerId = @learnerId AND l.CourseId = @courseId"), "progress is cut to this learner and course");
  }
  assert.equal(s.match(/COMMIT TRANSACTION;/g)?.length, 2, "both branches commit");
});

test("a second tab that loses the race opens nothing", async () => {
  const { calls, renewal } = fixture({ ...twoYear, CycleNo: 1 }, 0);
  assert.equal(await renewal.openRenewalIfDue("T", "L", "C", d("2026-10-01")), null);
  assert.equal(calls.length, 2);
});
