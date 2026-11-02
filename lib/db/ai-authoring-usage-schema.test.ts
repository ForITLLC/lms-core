import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0031_ai_authoring_usage.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim());

test("0031 is one guarded batch, so a rerun changes nothing", () => {
  assert.equal(batches.length, 1);
  const statements = batches[0]!.split(/(?=\bIF )/).filter((s) => s.trim());
  assert.equal(statements.length, 1);
  assert.match(statements[0]!, /^IF COL_LENGTH\('lms\.AssetIngestion', 'UsageJson'\) IS NULL ALTER TABLE lms\.AssetIngestion ADD UsageJson /);
});

test("UsageJson is nullable JSON, so rows from before it stay valid and the app can only write JSON", () => {
  assert.match(
    batches[0]!,
    /ADD UsageJson NVARCHAR\(MAX\) NULL CONSTRAINT CK_lms_AssetIngestion_UsageJson CHECK \(UsageJson IS NULL OR ISJSON\(UsageJson\) = 1\);$/,
  );
});

test("0031 follows 0030, the migration that made lms.AssetIngestion the job queue", () => {
  const names = readdirSync(new URL("../../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_/.test(f)).sort();
  assert.equal(names.filter((f) => f.startsWith("0031_")).length, 1);
  assert.equal(names[names.indexOf("0031_ai_authoring_usage.sql") - 1], "0030_ai_authoring_jobs.sql");
});
