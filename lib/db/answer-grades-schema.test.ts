import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Migration 0032 (slice A5a): marks for written answers, the AI marking queue
// and the tenant admin's switch. Run by scripts/run-migration.cjs, so its
// batches are split the way that script splits them.

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0032_answer_grades.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim());
const table = (name: string) => batches.find((b) => b.startsWith(`IF OBJECT_ID('lms.${name}', 'U') IS NULL CREATE TABLE lms.${name} (`));

test("0032 is five guarded batches, so a rerun changes nothing, and it touches no existing table", () => {
  assert.equal(batches.length, 5);
  for (const batch of batches) {
    assert.match(batch, /^IF OBJECT_ID\('lms\.(\w+)', 'U'\) IS NULL CREATE TABLE lms\.\1 \(|^IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = '(\w+)' AND object_id = OBJECT_ID\('lms\.\w+'\)\) CREATE (UNIQUE )?INDEX \2 /, batch.slice(0, 120));
    assert.doesNotMatch(batch.replaceAll("ON DELETE CASCADE", ""), /\b(ALTER|UPDATE|DELETE|DROP|INSERT)\b/);
    assert.doesNotMatch(batch, /\bdbo\./);
  }
  assert.ok(table("AnswerGrade") && table("AnswerGradingJob") && table("TenantAiSetting"));
});

test("a mark: whole points within its maximum, the AI's with model and prompt version, an instructor's with who and why", () => {
  const grade = table("AnswerGrade")!;
  assert.match(grade, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AnswerGrade_Tenant REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(grade, /Seq INT NOT NULL,/);
  assert.match(grade, /Source NVARCHAR\(16\) NOT NULL CONSTRAINT CK_lms_AnswerGrade_Source CHECK \(Source IN \('ai', 'instructor'\)\)/);
  assert.match(grade, /Score INT NOT NULL, MaxScore INT NOT NULL,/);
  assert.match(grade, /CONSTRAINT CK_lms_AnswerGrade_Score CHECK \(MaxScore > 0 AND Score >= 0 AND Score <= MaxScore\)/);
  assert.match(grade, /CONSTRAINT CK_lms_AnswerGrade_Who CHECK \( \(Source = 'ai' AND Model IS NOT NULL AND PromptVersion IS NOT NULL AND GradedBy IS NULL AND Reason IS NULL AND ConfirmsGradeId IS NULL\) OR \(Source = 'instructor' AND GradedBy IS NOT NULL AND Model IS NULL AND PromptVersion IS NULL\)\)/);
  assert.match(grade, /CONSTRAINT CK_lms_AnswerGrade_Reason CHECK \( Source = 'ai' OR ConfirmsGradeId IS NOT NULL OR \(Reason IS NOT NULL AND LEN\(LTRIM\(RTRIM\(Reason\)\)\) > 0\)\)/);
  assert.match(grade, /ConfirmsGradeId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AnswerGrade_Confirms REFERENCES lms\.AnswerGrade\(GradeId\)/);
  assert.match(grade, /CONSTRAINT FK_lms_AnswerGrade_Response FOREIGN KEY \(AttemptId, QuestionId\) REFERENCES lms\.AnswerResponse \(AttemptId, QuestionId\) ON DELETE CASCADE/);
  assert.match(grade, /GradedAt DATETIME2\(3\) NOT NULL CONSTRAINT DF_lms_AnswerGrade_GradedAt DEFAULT \(SYSUTCDATETIME\(\)\)/);
});

test("two writers that read the same marks can't both append: Seq is unique per tenant and attempt", () => {
  assert.ok(batches.includes(
    "IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_lms_AnswerGrade_TenantAttemptSeq' AND object_id = OBJECT_ID('lms.AnswerGrade')) "
    + "CREATE UNIQUE INDEX UX_lms_AnswerGrade_TenantAttemptSeq ON lms.AnswerGrade (TenantId, AttemptId, Seq);",
  ));
});

test("the marking queue: one job per answer per tenant, a status the worker knows, JSON usage", () => {
  const job = table("AnswerGradingJob")!;
  assert.match(job, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT FK_lms_AnswerGradingJob_Tenant REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(job, /Status NVARCHAR\(16\) NOT NULL CONSTRAINT DF_lms_AnswerGradingJob_Status DEFAULT \('queued'\) CONSTRAINT CK_lms_AnswerGradingJob_Status CHECK \(Status IN \('queued', 'running', 'completed', 'failed', 'cancelled'\)\)/);
  assert.match(job, /CONSTRAINT UQ_lms_AnswerGradingJob_Answer UNIQUE \(TenantId, AttemptId, QuestionId\)/);
  assert.match(job, /UsageJson NVARCHAR\(MAX\) NULL CONSTRAINT CK_lms_AnswerGradingJob_UsageJson CHECK \(UsageJson IS NULL OR ISJSON\(UsageJson\) = 1\)/);
  assert.match(job, /ResultGradeId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_AnswerGradingJob_Grade REFERENCES lms\.AnswerGrade\(GradeId\)/);
  assert.match(job, /CONSTRAINT FK_lms_AnswerGradingJob_Response FOREIGN KEY \(AttemptId, QuestionId\) REFERENCES lms\.AnswerResponse \(AttemptId, QuestionId\) ON DELETE CASCADE/);
  assert.ok(batches.some((b) => /CREATE INDEX IX_lms_AnswerGradingJob_StatusNotBefore ON lms\.AnswerGradingJob \(Status, NotBefore\);$/.test(b)));
});

test("the tenant switch starts off and records who changed it", () => {
  const setting = table("TenantAiSetting")!;
  assert.match(setting, /TenantId UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_lms_TenantAiSetting PRIMARY KEY CONSTRAINT FK_lms_TenantAiSetting_Tenant REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(setting, /GradeWrittenAnswers BIT NOT NULL CONSTRAINT DF_lms_TenantAiSetting_Grade DEFAULT \(0\)/);
  assert.match(setting, /UpdatedBy NVARCHAR\(256\) NOT NULL/);
});

test("0032 is the one migration of its number and follows 0031", () => {
  const names = readdirSync(new URL("../../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_/.test(f)).sort();
  assert.equal(names.filter((f) => f.startsWith("0032_")).length, 1);
  assert.equal(names[names.indexOf("0032_answer_grades.sql") - 1], "0031_ai_authoring_usage.sql");
});
