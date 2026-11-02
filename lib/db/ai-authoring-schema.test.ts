import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0030_ai_authoring_jobs.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim());

test("0030 is guarded statement by statement, so a rerun changes nothing", () => {
  assert.equal(batches.length, 5);
  for (const batch of batches) {
    const statements = batch.split(/(?=\bIF )/).filter((s) => s.trim());
    for (const statement of statements) {
      assert.match(statement, /^IF (NOT )?EXISTS \(|^IF COL_LENGTH\('lms\.AssetIngestion', '\w+'\) IS NULL /, statement.slice(0, 120));
    }
  }
  const columns = batches[0]!.match(/IF COL_LENGTH\('lms\.AssetIngestion', '(\w+)'\) IS NULL ALTER TABLE lms\.AssetIngestion ADD (\w+) /g) ?? [];
  assert.equal(columns.length, 12);
  for (const guard of columns) {
    const [, guarded, added] = /'(\w+)'\) IS NULL ALTER TABLE lms\.AssetIngestion ADD (\w+) /.exec(guard)!;
    assert.equal(guarded, added);
  }
});

test("the job columns the queue needs, with defaults that keep the old CLI's rows and inserts valid", () => {
  const add = batches[0]!;
  for (const column of [
    /ADD CreatedBy NVARCHAR\(256\) NULL;/,
    /ADD UpdatedAt DATETIME2\(3\) NOT NULL CONSTRAINT DF_lms_AssetIngestion_Updated DEFAULT \(SYSUTCDATETIME\(\)\);/,
    /ADD Stage NVARCHAR\(16\) NULL CONSTRAINT CK_lms_AssetIngestion_Stage CHECK \(Stage IN \('extract', 'outline', 'lessons', 'saving'\)\);/,
    /ADD LessonsDone INT NOT NULL CONSTRAINT DF_lms_AssetIngestion_LessonsDone DEFAULT \(0\);/,
    /ADD LessonsTotal INT NULL;/,
    /ADD Attempts INT NOT NULL CONSTRAINT DF_lms_AssetIngestion_Attempts DEFAULT \(0\);/,
    /ADD NotBefore DATETIME2\(3\) NOT NULL CONSTRAINT DF_lms_AssetIngestion_NotBefore DEFAULT \(SYSUTCDATETIME\(\)\);/,
    /ADD LeaseUntil DATETIME2\(3\) NULL;/,
    /ADD LeaseToken UNIQUEIDENTIFIER NULL;/,
    /ADD OptionsJson NVARCHAR\(MAX\) NULL CONSTRAINT CK_lms_AssetIngestion_OptionsJson CHECK \(OptionsJson IS NULL OR ISJSON\(OptionsJson\) = 1\);/,
    /ADD WorkJson NVARCHAR\(MAX\) NULL CONSTRAINT CK_lms_AssetIngestion_WorkJson CHECK \(WorkJson IS NULL OR ISJSON\(WorkJson\) = 1\);/,
    /ADD WarningsJson NVARCHAR\(MAX\) NULL CONSTRAINT CK_lms_AssetIngestion_WarningsJson CHECK \(WarningsJson IS NULL OR ISJSON\(WarningsJson\) = 1\);/,
  ]) {
    assert.match(add, column);
  }
});

test("only rows from before the queue are backfilled, in a batch after the columns exist", () => {
  const backfill = batches[1]!;
  assert.match(backfill, /^IF EXISTS \(SELECT 1 FROM lms\.AssetIngestion WHERE OptionsJson IS NULL AND \(CreatedBy IS NULL OR UpdatedAt <> CreatedAt\)\) UPDATE i /);
  assert.match(backfill, /SET CreatedBy = COALESCE\(i\.CreatedBy, c\.CreatedBy, N'ingest-cli'\), UpdatedAt = i\.CreatedAt/);
  assert.match(backfill, /LEFT JOIN lms\.Course c ON c\.CourseId = i\.ResultCourseId AND c\.TenantId = i\.TenantId/);
  assert.match(backfill, /WHERE i\.OptionsJson IS NULL AND \(i\.CreatedBy IS NULL OR i\.UpdatedAt <> i\.CreatedAt\); IF EXISTS /);
});

test("a CLI run from before the queue left 'running' for over an hour is failed, leaving UpdatedAt as the backfill set it", () => {
  const stale = "OptionsJson IS NULL AND Status = 'running' AND CreatedAt < DATEADD\\(hour, -1, SYSUTCDATETIME\\(\\)\\)";
  assert.match(
    batches[1]!,
    new RegExp(`IF EXISTS \\(SELECT 1 FROM lms\\.AssetIngestion WHERE ${stale}\\) UPDATE lms\\.AssetIngestion SET Status = 'failed', ErrorMessage = N'[^']+' WHERE ${stale};$`),
  );
});

test("a status check that admits the old CLI's statuses, and the queue's two indexes", () => {
  assert.match(batches[2]!, /ADD CONSTRAINT CK_lms_AssetIngestion_Status CHECK \(Status IN \('queued', 'running', 'completed', 'failed', 'cancelled'\)\);$/);
  assert.match(batches[3]!, /CREATE INDEX IX_lms_AssetIngestion_StatusNotBefore ON lms\.AssetIngestion \(Status, NotBefore\);$/);
  assert.match(batches[4]!, /CREATE INDEX IX_lms_AssetIngestion_TenantCreated ON lms\.AssetIngestion \(TenantId, CreatedAt DESC\);$/);
});
