import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Migration 0036 (slice R2a of docs/plans/2026-10-29-training-records-design.md):
// lms.PersonnelLink, and the rules a correction of a training record keeps.
// Run by scripts/run-migration.cjs, so its batches are split the way that
// script splits them. Permissions are a security change with a card of their
// own, so this migration grants and denies nothing.

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const migrations = new URL("../../db/migrations/", import.meta.url);
const source = readFileSync(new URL("0036_personnel_link.sql", migrations), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const batches = splitBatches(source).map(strip);
const code = strip(source);
const table = batches[0]!;

test("0036 is nine guarded batches, so a rerun changes nothing", () => {
  assert.equal(batches.length, 9);
  assert.match(batches[0]!, /^IF OBJECT_ID\('lms\.PersonnelLink', 'U'\) IS NULL CREATE TABLE lms\.PersonnelLink \(/);
  assert.match(batches[1]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'IX_lms_PersonnelLink_TenantLearnerEffective' AND object_id = OBJECT_ID\('lms\.PersonnelLink'\)\) CREATE INDEX /);
  assert.match(batches[2]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'UX_lms_PersonnelLink_Supersedes' AND object_id = OBJECT_ID\('lms\.PersonnelLink'\)\) CREATE UNIQUE INDEX UX_lms_PersonnelLink_Supersedes ON lms\.PersonnelLink \(SupersedesLinkId\) WHERE SupersedesLinkId IS NOT NULL;$/);
  assert.match(batches[3]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_PersonnelLink_NoUpdate ON lms\.PersonnelLink INSTEAD OF UPDATE AS BEGIN SET NOCOUNT ON; THROW 51038, N'[^']+', 1; END;$/);
  assert.match(batches[4]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_PersonnelLink_NoDelete ON lms\.PersonnelLink INSTEAD OF DELETE AS BEGIN SET NOCOUNT ON; THROW 51039, N'[^']+', 1; END;$/);
  assert.match(batches[5]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.check_constraints WHERE name = 'CK_lms_TrainingRecord_CorrectionReason' AND parent_object_id = OBJECT_ID\('lms\.TrainingRecord'\)\) ALTER TABLE lms\.TrainingRecord WITH CHECK ADD CONSTRAINT /);
  assert.match(batches[6]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'UX_lms_TrainingRecord_TenantLearnerRecord' AND object_id = OBJECT_ID\('lms\.TrainingRecord'\)\) CREATE UNIQUE INDEX UX_lms_TrainingRecord_TenantLearnerRecord ON lms\.TrainingRecord \(TenantId, LearnerId, RecordId\);$/);
  assert.match(batches[7]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.foreign_keys WHERE name = 'FK_lms_TrainingRecord_CorrectsSamePerson' AND parent_object_id = OBJECT_ID\('lms\.TrainingRecord'\)\) ALTER TABLE lms\.TrainingRecord WITH CHECK ADD CONSTRAINT FK_lms_TrainingRecord_CorrectsSamePerson FOREIGN KEY \(TenantId, LearnerId, CorrectsRecordId\) REFERENCES lms\.TrainingRecord \(TenantId, LearnerId, RecordId\);$/);
  assert.match(batches[8]!, /^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = 'UX_lms_TrainingRecord_Corrects' AND object_id = OBJECT_ID\('lms\.TrainingRecord'\)\) CREATE UNIQUE INDEX UX_lms_TrainingRecord_Corrects ON lms\.TrainingRecord \(CorrectsRecordId\) WHERE CorrectsRecordId IS NOT NULL;$/);
});

test("no existing row is changed or removed, and nothing cascades", () => {
  assert.doesNotMatch(code, /\bdbo\./);
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|MERGE|INSERT|DELETE FROM|NOCHECK)\b/);
  assert.doesNotMatch(code, /\bUPDATE lms\./);
  assert.doesNotMatch(code, /ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT)/i);
});

test("a personnel row names a learner of its own tenant, and a superseding row one of its own person", () => {
  assert.ok(table.includes("CONSTRAINT FK_lms_PersonnelLink_Learner FOREIGN KEY (TenantId, LearnerId) REFERENCES lms.Learner (TenantId, LearnerId)"));
  assert.ok(table.includes("CONSTRAINT UQ_lms_PersonnelLink_TenantLearnerLink UNIQUE (TenantId, LearnerId, PersonnelLinkId)"));
  assert.ok(table.includes("CONSTRAINT FK_lms_PersonnelLink_Supersedes FOREIGN KEY (TenantId, LearnerId, SupersedesLinkId) REFERENCES lms.PersonnelLink (TenantId, LearnerId, PersonnelLinkId)"));
  assert.ok(table.includes("CONSTRAINT CK_lms_PersonnelLink_Reason CHECK ( SupersedesLinkId IS NULL OR (Reason IS NOT NULL AND LEN(LTRIM(RTRIM(Reason))) > 0))"));
  assert.match(table, /CONSTRAINT CK_lms_PersonnelLink_DutyPosition CHECK \(DutyPosition IN \( 'pilot', 'flight_attendant', 'dispatcher', 'dg', 'ame', 'other'\)\)/);
  const all = readdirSync(migrations).filter((f) => f.endsWith(".sql")).map((f) => strip(readFileSync(new URL(f, migrations), "utf8"))).join(" ");
  assert.match(all, /CREATE UNIQUE INDEX UX_lms_Learner_Tenant_Id ON lms\.Learner\(TenantId, LearnerId\)/, "known positive: 0021 gives lms.Learner the key the composite foreign key needs");
});

test("the LMS keeps no licence or medical columns (design §3.6)", () => {
  const columns = [...table.matchAll(/(?:\( ?|, )(\w+) +(?:UNIQUEIDENTIFIER|NVARCHAR|DATE|DATETIME2)/g)].map((m) => m[1]);
  assert.deepEqual(columns, [
    "PersonnelLinkId", "TenantId", "LearnerId", "DutyPosition", "EmployeeNo", "HireDate", "LeaveDate", "EffectiveFrom",
    "CrewRecordsPersonRef", "SupersedesLinkId", "Reason", "RecordedBy", "RecordedAt",
  ]);
  assert.doesNotMatch(table, /licen[cs]e|medical/i);
});

test("a correction carries a reason the row hash covers", () => {
  assert.ok(batches[5]!.includes(
    "CHECK ( CASE WHEN CorrectsRecordId IS NULL THEN 1 WHEN PayloadJson IS NULL OR ISJSON(PayloadJson) = 0 THEN 0 " +
    "WHEN LEN(LTRIM(RTRIM(ISNULL(JSON_VALUE(PayloadJson, '$.correctionReason'), N'')))) > 0 THEN 1 ELSE 0 END = 1);",
  ));
});

test("no GRANT, DENY or REVOKE", () => {
  assert.doesNotMatch(code, /\b(GRANT|DENY|REVOKE)\b/i);
  assert.match(source, /-- Permissions are unchanged: no GRANT, DENY or REVOKE\./, "known positive: the comment says so");
});

test("0036 is the one migration of its number and follows 0035", () => {
  const names = readdirSync(migrations).filter((f) => /^\d{4}_/.test(f)).sort();
  assert.equal(names.filter((f) => f.startsWith("0036_")).length, 1);
  assert.equal(names[names.indexOf("0036_personnel_link.sql") - 1], "0035_exam_flag.sql");
});
