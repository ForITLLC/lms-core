import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0026_recertification_cycles.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/\s+/g, " "));

test("0026 is guarded batch by batch, so a rerun changes nothing", () => {
  assert.equal(batches.length, 6);
  for (const batch of batches) {
    assert.match(batch, /\bIF (NOT )?EXISTS \(|\bIF COL_LENGTH\(|\bIF OBJECT_ID\(/, batch.slice(0, 120));
  }
});

test("existing enrolments and certificates become cycle 1", () => {
  const sql = batches.join(" ");
  assert.match(sql, /ALTER TABLE lms\.Enrollment ADD CycleNo INT NOT NULL CONSTRAINT DF_lms_Enrollment_CycleNo DEFAULT \(1\)/);
  assert.match(sql, /ALTER TABLE lms\.Enrollment ADD CycleStartedAt DATETIME2\(3\) NULL/);
  assert.match(sql, /ALTER TABLE lms\.Certificate ADD CycleNo INT NOT NULL CONSTRAINT DF_lms_Certificate_CycleNo DEFAULT \(1\)/);
});

test("a certificate is unique per cycle; the old per-course key goes only after CycleNo exists", () => {
  const drop = batches.findIndex((b) => b.includes("DROP CONSTRAINT UQ_lms_Certificate_LearnerCourse;"));
  const add = batches.findIndex((b) => b.includes("UNIQUE (LearnerId, CourseId, CycleNo)"));
  const column = batches.findIndex((b) => b.includes("ALTER TABLE lms.Certificate ADD CycleNo"));
  assert.ok(column >= 0 && column < drop && drop < add, `order: column ${column}, drop ${drop}, add ${add}`);
  assert.doesNotMatch(batches.join(" "), /UQ_lms_Enrollment_LearnerCourse/);
});

test("finished cycles keep their block progress in lms.ProgressHistory", () => {
  const create = batches.find((b) => b.includes("CREATE TABLE lms.ProgressHistory"));
  assert.ok(create);
  assert.match(create, /CONSTRAINT PK_lms_ProgressHistory PRIMARY KEY \(LearnerId, BlockId, CycleNo\)/);
  assert.match(create, /REFERENCES lms\.Learner\(LearnerId\)/);
  assert.match(create, /REFERENCES lms\.Block\(BlockId\)/);
});
