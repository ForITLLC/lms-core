import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { RECORD_KINDS, RECORD_RESULTS, RECORD_SOURCES } from "@/lib/records/chain";

// Migration 0034 (slice R1a of docs/plans/2026-10-29-training-records-design.md):
// the append-only training record and its per-tenant chain head. Run by
// scripts/run-migration.cjs, so its batches are split the way that script
// splits them. Permissions are a security change with a card of their own,
// so this migration grants and denies nothing.

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0034_training_records.sql", import.meta.url);
const source = readFileSync(file, "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const batches = splitBatches(source).map(strip);
const code = strip(source);
const table = batches.find((b) => b.includes("CREATE TABLE lms.TrainingRecord ("))!;
const head = batches.find((b) => b.includes("CREATE TABLE lms.TrainingRecordChain ("))!;
const quoted = (list: string) => list.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));

test("0034 is five guarded batches, so a rerun changes nothing, and it touches no existing table", () => {
  assert.equal(batches.length, 5);
  assert.match(batches[0]!, /^IF OBJECT_ID\('lms\.TrainingRecordChain', 'U'\) IS NULL CREATE TABLE lms\.TrainingRecordChain \(/);
  assert.match(batches[1]!, /^IF OBJECT_ID\('lms\.TrainingRecord', 'U'\) IS NULL CREATE TABLE lms\.TrainingRecord \(/);
  assert.match(batches[2]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'IX_lms_TrainingRecord_TenantLearnerOccurred' AND object_id = OBJECT_ID\('lms\.TrainingRecord'\)\) CREATE INDEX/);
  assert.match(batches[3]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_TrainingRecord_NoUpdate ON lms\.TrainingRecord INSTEAD OF UPDATE AS BEGIN/);
  assert.match(batches[4]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_TrainingRecord_NoDelete ON lms\.TrainingRecord INSTEAD OF DELETE AS BEGIN/);
  assert.doesNotMatch(batches.slice(0, 3).join(" "), /\b(ALTER|UPDATE|DELETE|DROP|INSERT|MERGE|TRUNCATE)\b/);
  assert.doesNotMatch(code, /\bdbo\./);
});

test("the triggers refuse every UPDATE and DELETE, whoever runs it, and do nothing else", () => {
  for (const [batch, verb, number] of [[batches[3]!, "UPDATE", 51034], [batches[4]!, "DELETE", 51035]] as const) {
    assert.match(batch, new RegExp(`INSTEAD OF ${verb} AS BEGIN SET NOCOUNT ON; THROW ${number}, N'lms\\.TrainingRecord is append-only: [^']+', 1; END;$`));
    assert.doesNotMatch(batch.replace(/N'[^']*'/g, ""), /\b(INSERT|UPDATE lms|DELETE FROM|EXECUTE AS|ROLLBACK)\b/);
  }
});

test("no GRANT, DENY or REVOKE: the app login's DENY UPDATE, DELETE waits on its own decided card", () => {
  assert.doesNotMatch(code, /\b(GRANT|DENY|REVOKE)\b/i);
  assert.match(source, /-- .*DENY UPDATE, DELETE/, "known positive: the comments still say why");
});

test("no foreign key cascades: an INSTEAD OF trigger can't sit on a table with one, and deleting a learner must not take their records", () => {
  assert.doesNotMatch(code, /ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT)/i);
  assert.match(table, /LearnerId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_TrainingRecord_Learner REFERENCES lms\.Learner\(LearnerId\),/);
  assert.match(table, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_TrainingRecord_Tenant REFERENCES lms\.Tenant\(TenantId\),/);
  assert.match(table, /CorrectsRecordId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_TrainingRecord_Corrects REFERENCES lms\.TrainingRecord\(RecordId\),/);
  for (const plainId of ["CourseId", "CourseVersionId", "QuizId", "AttemptId"]) {
    assert.match(table, new RegExp(`\\b${plainId} UNIQUEIDENTIFIER NULL,`), `${plainId} is a plain id: editing a course or an attempt never touches a record`);
  }
  assert.match(table, /PersonName NVARCHAR\(256\) NOT NULL, PersonEmail NVARCHAR\(320\) NOT NULL,/, "the person is a snapshot");
});

test("Seq is unique per tenant and both hashes are 32 bytes", () => {
  assert.match(table, /Seq BIGINT NOT NULL CONSTRAINT CK_lms_TrainingRecord_Seq CHECK \(Seq >= 1\)/);
  assert.match(table, /CONSTRAINT UQ_lms_TrainingRecord_TenantSeq UNIQUE \(TenantId, Seq\)/);
  for (const name of ["PrevHash", "RowHash"]) {
    assert.match(table, new RegExp(`${name} VARBINARY\\(32\\) NOT NULL CONSTRAINT CK_lms_TrainingRecord_${name} CHECK \\(DATALENGTH\\(${name}\\) = 32\\)`));
  }
  assert.match(head, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TrainingRecordChain PRIMARY KEY CONSTRAINT FK_lms_TrainingRecordChain_Tenant REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(head, /LastSeq BIGINT NOT NULL CONSTRAINT CK_lms_TrainingRecordChain_LastSeq CHECK \(LastSeq >= 0\)/);
  assert.match(head, /LastHash VARBINARY\(32\) NOT NULL CONSTRAINT CK_lms_TrainingRecordChain_LastHash CHECK \(DATALENGTH\(LastHash\) = 32\)/);
  assert.match(batches[2]!, /ON lms\.TrainingRecord \(TenantId, LearnerId, OccurredAt\);?$/);
});

test("the kinds, results and sources are the app's own lists, and the times keep milliseconds", () => {
  const list = (name: string) => quoted(new RegExp(`CONSTRAINT CK_lms_TrainingRecord_${name} CHECK \\(${name} IN \\(([^)]*)\\)\\)`).exec(table)![1]!);
  assert.deepEqual(list("Kind"), [...RECORD_KINDS]);
  assert.deepEqual(list("Result"), [...RECORD_RESULTS]);
  assert.deepEqual(list("Source"), [...RECORD_SOURCES]);
  for (const name of ["OccurredAt", "RecordedAt"]) assert.match(table, new RegExp(`${name} DATETIME2\\(3\\) NOT NULL,`));
});

test("a kind carries only its own results, a scored result matches its score, and a fail always says why", () => {
  const rule = (name: string) => new RegExp(`CONSTRAINT CK_lms_TrainingRecord_${name} CHECK \\(`).exec(table) !== null;
  for (const name of ["KindResult", "Score", "FailureDetail", "RecordedBy", "Corrects", "PayloadJson"]) assert.ok(rule(name), name);
  for (const pair of [
    "(Kind = 'course_completion' AND Result = 'completed')",
    "(Kind = 'exam_pass' AND Result = 'pass')",
    "(Kind = 'exam_fail' AND Result = 'fail')",
    "(Kind = 'exam_attempt_pending' AND Result = 'pending')",
    "(Kind = 'grade_change' AND Result IN ('pass', 'fail'))",
  ]) assert.ok(table.includes(pair), pair);
  assert.ok(table.includes("(Kind NOT IN ('exam_pass', 'exam_fail', 'grade_change') OR (Score IS NOT NULL AND PassingScore IS NOT NULL))"));
  assert.ok(table.includes("(Result <> 'pass' OR Score IS NULL OR PassingScore IS NULL OR Score >= PassingScore)"));
  assert.ok(table.includes("(Result <> 'fail' OR Score IS NULL OR PassingScore IS NULL OR Score < PassingScore)"));
  assert.ok(table.includes("Result <> 'fail' OR (FailureDetail IS NOT NULL AND LEN(LTRIM(RTRIM(FailureDetail))) > 0))"));
  assert.ok(table.includes("CHECK (PayloadJson IS NULL OR ISJSON(PayloadJson) = 1)"));
});

test("0034 is the one migration of its number and follows 0033", () => {
  const names = readdirSync(new URL("../../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_/.test(f)).sort();
  assert.equal(names.filter((f) => f.startsWith("0034_")).length, 1);
  assert.equal(names[names.indexOf("0034_training_records.sql") - 1], "0033_answer_review_requests.sql");
});
