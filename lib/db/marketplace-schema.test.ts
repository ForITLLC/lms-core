import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as {
  splitBatches: (content: string) => string[];
};

const file = new URL("../../db/migrations/0027_marketplace_entitlements.sql", import.meta.url);
const batches = splitBatches(readFileSync(file, "utf8")).map((b) => b.replace(/\s+/g, " "));

test("0027 is guarded batch by batch, so a rerun changes nothing", () => {
  assert.equal(batches.length, 5);
  for (const batch of batches) {
    assert.match(batch, /\bIF (NOT )?EXISTS \(|\bIF COL_LENGTH\(|\bIF OBJECT_ID\(/, batch.slice(0, 120));
  }
});

test("existing tenants are not publishers until ForIT marks them", () => {
  assert.match(
    batches.join(" "),
    /ALTER TABLE lms\.Tenant ADD IsPublisher BIT NOT NULL CONSTRAINT DF_lms_Tenant_IsPublisher DEFAULT \(0\)/,
  );
});

test("one entitlement per marketplace order line, and a closed one holds no seats", () => {
  const create = batches.find((b) => b.includes("CREATE TABLE lms.Entitlement"));
  assert.ok(create);
  assert.match(create, /OrderLineId NVARCHAR\(128\) NOT NULL CONSTRAINT UQ_lms_Entitlement_OrderLine UNIQUE/);
  assert.match(create, /CHECK \(Seats >= 0\)/);
  assert.match(create, /CHECK \(Status IN \('active', 'closed'\) AND \(Status = 'active' OR Seats = 0\)\)/);
  assert.match(create, /REFERENCES lms\.Tenant\(TenantId\)/);
  assert.match(create, /REFERENCES lms\.Course\(CourseId\)/);
  assert.match(create, /REFERENCES lms\.CourseVersion\(VersionId\)/);
});

test("an assignment records the entitlement it used, after lms.Entitlement exists", () => {
  const table = batches.findIndex((b) => b.includes("CREATE TABLE lms.Entitlement"));
  const column = batches.findIndex((b) => b.includes("ALTER TABLE lms.CourseAssignment ADD EntitlementId"));
  const index = batches.findIndex((b) => b.includes("ON lms.CourseAssignment (EntitlementId)"));
  assert.ok(table >= 0 && table < column && column < index, `order: table ${table}, column ${column}, index ${index}`);
  assert.match(
    batches[column] ?? "",
    /ADD EntitlementId UNIQUEIDENTIFIER NULL CONSTRAINT FK_lms_CourseAssignment_Entitlement REFERENCES lms\.Entitlement\(EntitlementId\)/,
  );
});
