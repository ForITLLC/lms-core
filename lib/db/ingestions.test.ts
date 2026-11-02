import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as usage from "@/lib/ai/authoring/usage";

// The job queue's statements: the cross-tenant claim is the only one that
// doesn't name the job's tenant, every write after a claim needs the worker's
// lease token, and nothing that reads a job for a page returns its work.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const JOB = "abababab-0000-0000-0000-0000000000ab";
const LEASE = "1e1e1e1e-0000-0000-0000-00000000001e";

interface Call { kind: string; sql: string; params: Record<string, unknown> }

function load(answer: (sql: string) => unknown = () => null) {
  const calls: Call[] = [];
  const record = (kind: string) => async (sql: string, params: Record<string, unknown> = {}) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    calls.push({ kind, sql: flat, params });
    const out = answer(flat);
    return kind === "query" ? (Array.isArray(out) ? out : []) : out;
  };
  const db = { query: record("query"), queryOne: record("queryOne"), execute: record("execute") };
  const code = ts.transpileModule(readFileSync(new URL("./ingestions.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const modules: Record<string, unknown> = { "node:crypto": crypto, "@/lib/db": db, "@/lib/ai/authoring/usage": usage };
  const exports: any = {};
  runInNewContext(code, { exports, JSON, Math, Array, require: (name: string) => {
    if (!(name in modules)) throw new Error(`unexpected import ${name}`);
    return modules[name];
  } });
  return { mod: exports, calls };
}

const claimRow = {
  IngestionId: JOB.toUpperCase(), TenantId: TENANT.toUpperCase(), CreatedBy: "a@example.test", SourceKind: "youtube",
  SourceRef: "https://youtu.be/x", Stage: null, Attempts: 1, OptionsJson: "{}", WorkJson: null, UsageJson: null, ResultCourseId: null,
};
const USAGE = JSON.stringify({ "claude-sonnet-4-6": { calls: 2, inputTokens: 10, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 } });
const job = { ingestionId: JOB, tenantId: TENANT, leaseToken: LEASE };
const HELD = /WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken AND Status = 'running'/;

test("the claim takes one due or abandoned job of any tenant, skipping rows another worker holds, and returns it lower-case with a fresh lease", async () => {
  const { mod, calls } = load(() => claimRow);
  const claimed = await mod.claimNextIngestion();
  assert.equal(calls.length, 1);
  const [claim] = calls;
  assert.match(claim!.sql, /^WITH next AS \( SELECT TOP \(1\) \* FROM lms\.AssetIngestion WITH \(UPDLOCK, READPAST, ROWLOCK\) WHERE \(\(Status = 'queued' AND NotBefore <= SYSUTCDATETIME\(\)\) OR \(Status = 'running' AND LeaseUntil < SYSUTCDATETIME\(\)\)\) ORDER BY NotBefore, CreatedAt \) UPDATE next SET Status = 'running', Attempts = Attempts \+ 1, LeaseToken = @leaseToken, LeaseUntil = DATEADD\(second, @leaseSeconds, SYSUTCDATETIME\(\)\), UpdatedAt = SYSUTCDATETIME\(\) OUTPUT /);
  assert.doesNotMatch(claim!.sql, /@tenantId/);
  assert.deepEqual(Object.keys(claim!.params).sort(), ["leaseSeconds", "leaseToken"]);
  assert.equal(claim!.params.leaseSeconds, mod.LEASE_SECONDS);
  assert.match(String(claim!.params.leaseToken), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(claimed.leaseToken, claim!.params.leaseToken);
  assert.equal(claimed.ingestionId, JOB);
  assert.equal(claimed.tenantId, TENANT);

  const none = load(() => null);
  assert.equal(await none.mod.claimNextIngestion(), null);
});

test("every statement but the claim names the job's tenant, and every write after a claim needs the lease token", async () => {
  const { mod, calls } = load((sql) => (sql.startsWith("SELECT") ? null : sql.startsWith("UPDATE lms.AssetIngestion WITH") ? claimRow : 1));
  await mod.enqueueIngestion(TENANT, { createdBy: "a@example.test", sourceKind: "youtube", sourceRef: "https://youtu.be/x", options: {} });
  await mod.claimIngestion(TENANT, JOB);
  const update = { stage: "outline", workJson: "{}", lessonsDone: 0, lessonsTotal: null, warningsJson: "[]", usageJson: USAGE };
  assert.equal(await mod.saveIngestionWork(job, update), true);
  assert.equal(await mod.completeIngestion(job, USAGE), true);
  assert.equal(await mod.failIngestion(job, "x", USAGE), true);
  assert.equal(await mod.requeueIngestion(job, 60, "x", USAGE), true);
  assert.equal(await mod.pauseIngestion(job, USAGE), true);
  await mod.getIngestion(TENANT, JOB);
  await mod.listIngestions(TENANT);

  assert.equal(calls.length, 9);
  for (const call of calls) {
    assert.equal(call.params.tenantId, TENANT, call.sql);
    assert.match(call.sql, /TenantId = @tenantId|VALUES \(@ingestionId, @tenantId,/, call.sql);
  }
  assert.match(calls[0]!.sql, /^INSERT INTO lms\.AssetIngestion \(IngestionId, TenantId, SourceKind, SourceRef, Status, CreatedBy, OptionsJson\) VALUES \(@ingestionId, @tenantId, @sourceKind, @sourceRef, 'queued', @createdBy, @options\)$/);
  assert.match(calls[1]!.sql, /^UPDATE lms\.AssetIngestion WITH \(UPDLOCK, READPAST\) SET Status = 'running'.* WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND \(\(Status = 'queued'/);
  for (const write of calls.slice(2, 7)) {
    assert.match(write.sql, HELD, write.sql);
    assert.equal(write.params.leaseToken, LEASE, write.sql);
    assert.equal(write.params.ingestionId, JOB, write.sql);
  }
  assert.match(calls[3]!.sql, /SET Status = 'completed', WorkJson = NULL.* AND ResultCourseId IS NOT NULL$/);
  assert.match(calls[4]!.sql, /SET Status = 'failed', ErrorMessage = @message.* AND ResultCourseId IS NULL$/);
  assert.match(calls[5]!.sql, /SET Status = 'queued', NotBefore = DATEADD\(second, @delaySeconds, SYSUTCDATETIME\(\)\).* AND ResultCourseId IS NULL$/);
  assert.match(calls[6]!.sql, /SET Status = 'queued', NotBefore = SYSUTCDATETIME\(\), Attempts = CASE WHEN Attempts > 0 THEN Attempts - 1 ELSE 0 END/);
});

test("a write whose lease was taken changes no row and says so", async () => {
  const { mod } = load(() => 0);
  const update = { stage: "lessons", workJson: "{}", lessonsDone: 1, lessonsTotal: 3, warningsJson: "[]", usageJson: USAGE };
  assert.equal(await mod.saveIngestionWork(job, update), false);
  assert.equal(await mod.completeIngestion(job, USAGE), false);
  assert.equal(await mod.failIngestion(job, "x", USAGE), false);
  assert.equal(await mod.requeueIngestion(job, 60, "x", USAGE), false);
  assert.equal(await mod.pauseIngestion(job, USAGE), false);
});

test("a job read for a page never carries its work or options, which hold the source's text", async () => {
  const { mod, calls } = load(() => null);
  await mod.getIngestion(TENANT, JOB);
  await mod.listIngestions(TENANT, 500);
  for (const call of calls) assert.doesNotMatch(call.sql, /WorkJson|OptionsJson|\*/, call.sql);
  assert.equal(calls[1]!.params.limit, 100);
  const source = readFileSync(new URL("./ingestions.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source.slice(source.indexOf("const RECORD_COLUMNS"), source.indexOf("function toClaimed")), /WorkJson|OptionsJson/);
});

test("every write after a claim keeps the job's running token usage, under the same guards; the claim hands back what earlier attempts spent", async () => {
  const { mod, calls } = load((sql) => (sql.startsWith("WITH next AS") ? { ...claimRow, UsageJson: USAGE } : 1));
  const claimed = await mod.claimNextIngestion();
  assert.match(calls[0]!.sql, /OUTPUT .*inserted\.UsageJson/);
  assert.equal(claimed.usageJson, USAGE);

  const update = { stage: "lessons", workJson: "{}", lessonsDone: 1, lessonsTotal: 3, warningsJson: "[]", usageJson: USAGE };
  await mod.saveIngestionWork(job, update);
  await mod.completeIngestion(job, USAGE);
  await mod.failIngestion(job, "x", USAGE);
  await mod.requeueIngestion(job, 60, "x", USAGE);
  await mod.pauseIngestion(job, USAGE);
  const writes = calls.slice(1);
  assert.equal(writes.length, 5);
  for (const write of writes) {
    assert.match(write.sql, /SET .*\bUsageJson = @usage,/, write.sql);
    assert.equal(write.params.usage, USAGE, write.sql);
    assert.match(write.sql, HELD, write.sql);
  }
  assert.match(writes[0]!.sql, / WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken AND Status = 'running'$/);
  assert.match(writes[1]!.sql, / AND Status = 'running' AND ResultCourseId IS NOT NULL$/);
  assert.match(writes[2]!.sql, / AND Status = 'running' AND ResultCourseId IS NULL$/);
  assert.match(writes[3]!.sql, / AND Status = 'running' AND ResultCourseId IS NULL$/);
  assert.match(writes[4]!.sql, / AND Status = 'running'$/);
});

test("a job read for a page carries its token usage, read as none when NULL or unreadable", async () => {
  const record = (UsageJson: string | null) => ({
    IngestionId: JOB.toUpperCase(), Status: "completed", Stage: "saving", LessonsDone: 3, LessonsTotal: 3, Attempts: 2,
    SourceKind: "youtube", SourceRef: "https://youtu.be/x", WarningsJson: null, UsageJson, ResultCourseId: null, ErrorMessage: null,
    CreatedBy: "a@example.test", CreatedAt: new Date(0), UpdatedAt: new Date(0), NotBefore: new Date(0),
  });
  const read = async (json: string | null) => {
    const { mod, calls } = load((sql) => (sql.startsWith("SELECT TOP") ? [record(json)] : record(json)));
    const one = await mod.getIngestion(TENANT, JOB);
    const [listed] = await mod.listIngestions(TENANT);
    assert.match(calls[0]!.sql, /\bUsageJson\b/);
    assert.deepEqual(listed.usage, one.usage);
    return JSON.parse(JSON.stringify(one.usage));
  };
  assert.deepEqual(await read(USAGE), JSON.parse(USAGE));
  for (const unreadable of [null, "", "not json", "[1,2]", "{\"m\":{\"calls\":1}}", "{\"m\":{\"calls\":-1,\"inputTokens\":0,\"outputTokens\":0,\"cacheWriteTokens\":0,\"cacheReadTokens\":0}}"]) {
    assert.deepEqual(await read(unreadable), {}, String(unreadable));
  }
});

// ---- A4: an author's enqueue, under the tenant's caps -------------------------

const INPUT = { createdBy: "a@example.test", sourceKind: "youtube", sourceRef: "https://youtu.be/x", options: { lessonCount: 4, quizzes: false } };
const LIMITS = { maxActive: 2, maxPerMonth: 20 };

test("an author's enqueue locks the tenant's row, counts only that tenant's jobs and inserts only under both caps, in one transaction", async () => {
  const { mod, calls } = load(() => ({ Queued: true, Active: 1, ThisMonth: 7 }));
  const result = await mod.enqueueIngestionWithinLimits(TENANT, INPUT, LIMITS);
  assert.equal(calls.length, 1, "the count and the insert are one statement batch");
  const { kind, sql, params } = calls[0]!;
  assert.equal(kind, "queryOne");
  const statements = sql.split(/;\s*/).filter(Boolean);
  assert.deepEqual(statements, [
    "SET XACT_ABORT ON",
    "BEGIN TRANSACTION",
    "DECLARE @held bit, @active int, @thisMonth int",
    "SELECT @held = 1 FROM lms.Tenant WITH (UPDLOCK, HOLDLOCK) WHERE TenantId = @tenantId",
    "SELECT @active = COUNT(CASE WHEN Status IN ('queued', 'running') THEN 1 END), @thisMonth = COUNT(CASE WHEN CreatedAt >= DATEFROMPARTS(YEAR(SYSUTCDATETIME()), MONTH(SYSUTCDATETIME()), 1) THEN 1 END) FROM lms.AssetIngestion WHERE TenantId = @tenantId",
    "IF @active < @maxActive AND @thisMonth < @maxPerMonth INSERT INTO lms.AssetIngestion (IngestionId, TenantId, SourceKind, SourceRef, Status, CreatedBy, OptionsJson) VALUES (@ingestionId, @tenantId, @sourceKind, @sourceRef, 'queued', @createdBy, @options)",
    "COMMIT TRANSACTION",
    "SELECT CAST(CASE WHEN @active < @maxActive AND @thisMonth < @maxPerMonth THEN 1 ELSE 0 END AS bit) AS Queued, @active AS Active, @thisMonth AS ThisMonth",
  ]);
  assert.deepEqual(Object.keys(params).sort(), ["createdBy", "ingestionId", "maxActive", "maxPerMonth", "options", "sourceKind", "sourceRef", "tenantId"]);
  assert.deepEqual(
    [params.tenantId, params.createdBy, params.sourceKind, params.sourceRef, params.options, params.maxActive, params.maxPerMonth],
    [TENANT, "a@example.test", "youtube", "https://youtu.be/x", JSON.stringify(INPUT.options), 2, 20],
  );
  assert.match(String(params.ingestionId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { queued: true, ingestionId: params.ingestionId });

  const other = load(() => ({ Queued: 1, Active: 0, ThisMonth: 0 }));
  await other.mod.enqueueIngestionWithinLimits(TENANT, INPUT, { maxActive: 5, maxPerMonth: 50 });
  assert.deepEqual([other.calls[0]!.params.maxActive, other.calls[0]!.params.maxPerMonth], [5, 50], "the caps come from the caller, not the SQL");
});

test("a refused enqueue says which cap was reached, the monthly one first; an empty answer is an error", async () => {
  const answer = async (row: unknown) => JSON.parse(JSON.stringify(await load(() => row).mod.enqueueIngestionWithinLimits(TENANT, INPUT, LIMITS)));
  assert.deepEqual(await answer({ Queued: false, Active: 2, ThisMonth: 5 }), { queued: false, reached: "active", active: 2, thisMonth: 5 });
  assert.deepEqual(await answer({ Queued: 0, Active: 0, ThisMonth: 20 }), { queued: false, reached: "monthly", active: 0, thisMonth: 20 });
  assert.deepEqual(await answer({ Queued: false, Active: 2, ThisMonth: 21 }), { queued: false, reached: "monthly", active: 2, thisMonth: 21 });
  await assert.rejects(load(() => null).mod.enqueueIngestionWithinLimits(TENANT, INPUT, LIMITS), /The enqueue answered nothing/);
});

test("the course editor's banner reads the job that made a course for the session's tenant only, without its work or options", async () => {
  const row = {
    IngestionId: JOB.toUpperCase(), Status: "completed", Stage: "saving", LessonsDone: 3, LessonsTotal: 3, Attempts: 1,
    SourceKind: "url", SourceRef: "https://aviation.example/wake", WarningsJson: "[]", UsageJson: null,
    ResultCourseId: "C0C0C0C0-0000-0000-0000-00000000000C", ErrorMessage: null, CreatedBy: "a@example.test",
    CreatedAt: new Date(0), UpdatedAt: new Date(0), NotBefore: new Date(0),
  };
  const { mod, calls } = load(() => row);
  const found = await mod.getCourseIngestion(TENANT, "c0c0c0c0-0000-0000-0000-00000000000c");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /^SELECT TOP \(1\) .* FROM lms\.AssetIngestion WHERE TenantId = @tenantId AND ResultCourseId = @courseId ORDER BY CreatedAt DESC$/);
  assert.doesNotMatch(calls[0]!.sql, /WorkJson|OptionsJson|\*/);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0]!.params)), { tenantId: TENANT, courseId: "c0c0c0c0-0000-0000-0000-00000000000c" });
  assert.deepEqual([found.ingestionId, found.courseId, found.sourceKind], [JOB, "c0c0c0c0-0000-0000-0000-00000000000c", "url"]);
  assert.equal(await load(() => null).mod.getCourseIngestion(TENANT, "c0c0c0c0-0000-0000-0000-00000000000c"), null);
});
