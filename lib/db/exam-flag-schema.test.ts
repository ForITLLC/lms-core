import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Migration 0035 (slice R1b of docs/plans/2026-10-29-training-records-design.md):
// lms.Quiz.IsExam, and an exam's attempts are kept. Run by
// scripts/run-migration.cjs, so its batches are split the way that script
// splits them. Permissions are a security change with a card of their own,
// so this migration grants and denies nothing.

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const migrations = new URL("../../db/migrations/", import.meta.url);
const source = readFileSync(new URL("0035_exam_flag.sql", migrations), "utf8");
const strip = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const batches = splitBatches(source).map(strip);
const code = strip(source);

test("0035 is three guarded batches, so a rerun changes nothing, and every existing quiz reads as practice", () => {
  assert.equal(batches.length, 3);
  assert.equal(batches[0], "IF COL_LENGTH('lms.Quiz', 'IsExam') IS NULL ALTER TABLE lms.Quiz ADD IsExam BIT NOT NULL CONSTRAINT DF_lms_Quiz_IsExam DEFAULT (0);");
  assert.match(batches[1]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_QuizAttempt_KeepExams ON lms\.QuizAttempt INSTEAD OF DELETE AS BEGIN/);
  assert.match(batches[2]!, /^CREATE OR ALTER TRIGGER lms\.TR_lms_Quiz_ExamStays ON lms\.Quiz AFTER UPDATE AS BEGIN/);
  assert.doesNotMatch(code, /\bdbo\./);
  assert.doesNotMatch(code, /\b(DROP|TRUNCATE|MERGE|INSERT)\b/);
  assert.doesNotMatch(code, /\bUPDATE lms\./, "no backfill: nothing becomes an exam until an author says so");
});

test("a DELETE naming any exam attempt is refused whole; any other delete goes through as before", () => {
  const keep = batches[1]!;
  assert.match(keep, /AS BEGIN SET NOCOUNT ON; IF EXISTS \(SELECT 1 FROM deleted d JOIN lms\.Quiz q ON q\.QuizId = d\.QuizId WHERE q\.IsExam = 1\) THROW 51036, N'[^']+', 1; DELETE a FROM lms\.QuizAttempt a JOIN deleted d ON d\.AttemptId = a\.AttemptId; END;$/);
  assert.doesNotMatch(keep, /\b(EXECUTE AS|ROLLBACK|UPDATE)\b/);
});

test("an exam stays an exam: clearing IsExam on a published quiz is refused", () => {
  assert.match(batches[2]!, /AS BEGIN SET NOCOUNT ON; IF EXISTS \(SELECT 1 FROM deleted d WHERE d\.IsExam = 1 AND NOT EXISTS \(SELECT 1 FROM inserted i WHERE i\.QuizId = d\.QuizId AND i\.IsExam = 1\)\) THROW 51037, N'[^']+', 1; END;$/);
});

test("lms.QuizAttempt has no cascading foreign key of its own, so it can carry an INSTEAD OF DELETE trigger", () => {
  const all = readdirSync(migrations).filter((f) => f.endsWith(".sql")).map((f) => strip(readFileSync(new URL(f, migrations), "utf8")));
  const create = all.map((sql) => sql.match(/CREATE TABLE lms\.QuizAttempt \((.*?)\);/)?.[1]).find(Boolean);
  assert.ok(create, "known positive: 0001 creates lms.QuizAttempt");
  assert.match(create!, /REFERENCES lms\.Quiz\(QuizId\)/);
  assert.doesNotMatch(create!, /ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT)/i);
  const altered = all.flatMap((sql) => sql.match(/ALTER TABLE lms\.QuizAttempt [^;]*/g) ?? []);
  for (const alter of altered) assert.doesNotMatch(alter, /ON (DELETE|UPDATE) (CASCADE|SET NULL|SET DEFAULT)/i, alter);
  assert.match(all.join(" "), /REFERENCES lms\.QuizAttempt\(AttemptId\) ON DELETE CASCADE/, "known positive: answers still cascade with a practice attempt");
});

test("no GRANT, DENY or REVOKE", () => {
  assert.doesNotMatch(code, /\b(GRANT|DENY|REVOKE)\b/i);
  assert.match(source, /-- Permissions are unchanged: no GRANT, DENY or REVOKE\./, "known positive: the comment says so");
});
