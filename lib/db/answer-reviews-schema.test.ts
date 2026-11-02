import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Migration 0033 (slice A5b): a learner's request for an instructor to look
// again at one written answer's mark. Run by scripts/run-migration.cjs, so its
// batches are split the way that script splits them.

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0033_answer_review_requests.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim());

test("0033 is one guarded batch, so a rerun changes nothing, and it touches no existing table", () => {
  assert.equal(batches.length, 1);
  const [batch] = batches;
  assert.match(batch!, /^IF OBJECT_ID\('lms\.AnswerReviewRequest', 'U'\) IS NULL CREATE TABLE lms\.AnswerReviewRequest \(/);
  assert.doesNotMatch(batch!.replaceAll("ON DELETE CASCADE", ""), /\b(ALTER|UPDATE|DELETE|DROP|INSERT)\b/);
  assert.doesNotMatch(batch!, /\bdbo\./);
});

test("a request belongs to a tenant and one written answer, is asked once, and names the mark that answered it", () => {
  const table = batches[0]!;
  assert.match(table, /RequestId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_AnswerReviewRequest PRIMARY KEY/);
  assert.match(table, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AnswerReviewRequest_Tenant REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(table, /AttemptId UNIQUEIDENTIFIER NOT NULL, QuestionId UNIQUEIDENTIFIER NOT NULL,/);
  assert.match(table, /RequestedBy NVARCHAR\(320\) NOT NULL, Note NVARCHAR\(500\) NULL,/);
  assert.match(table, /RequestedAt DATETIME2\(3\) NOT NULL CONSTRAINT DF_lms_AnswerReviewRequest_RequestedAt DEFAULT \(SYSUTCDATETIME\(\)\)/);
  assert.match(table, /ResolvedByGradeId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AnswerReviewRequest_Grade REFERENCES lms\.AnswerGrade\(GradeId\)/);
  assert.match(table, /CONSTRAINT FK_lms_AnswerReviewRequest_Response FOREIGN KEY \(AttemptId, QuestionId\) REFERENCES lms\.AnswerResponse \(AttemptId, QuestionId\) ON DELETE CASCADE/);
  assert.match(table, /CONSTRAINT UQ_lms_AnswerReviewRequest_Answer UNIQUE \(TenantId, AttemptId, QuestionId\)/);
});

test("0033 is the one migration of its number and follows 0032", () => {
  const names = readdirSync(new URL("../../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_/.test(f)).sort();
  assert.equal(names.filter((f) => f.startsWith("0033_")).length, 1);
  assert.equal(names[names.indexOf("0033_answer_review_requests.sql") - 1], "0032_answer_grades.sql");
});
