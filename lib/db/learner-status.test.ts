import { test } from "node:test";
import assert from "node:assert/strict";
import { flat, vmLoad } from "@/lib/fixtures/fake-grading-db";

// Marking a learner left or active (slice R1b): one tenant-scoped statement
// that moves only 'active' and 'left' and writes its audit event in the same
// transaction.

function load(row: { Was: string | null; Changed: boolean | number } | null) {
  const calls: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const mod = vmLoad(new URL("./learner-status.ts", import.meta.url), {
    "@/lib/db": { queryOne: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return row; } },
  });
  return { mod, calls };
}

test("the statement is tenant-scoped, locks the row, and writes the status and its audit event in one transaction", async () => {
  const { mod, calls } = load({ Was: "active", Changed: 1 });
  await mod.setLearnerStatus("T", "L", "left", "admin@a.test");
  assert.deepEqual({ ...calls[0]!.params }, { tenantId: "T", learnerId: "L", status: "left", by: "admin@a.test" });
  const sql = flat(mod.SET_LEARNER_STATUS);
  assert.match(sql, /^SET XACT_ABORT ON; SET NOCOUNT ON; BEGIN TRANSACTION;/);
  assert.match(sql, /FROM lms\.Learner WITH \(UPDLOCK, HOLDLOCK\) WHERE TenantId = @tenantId AND LearnerId = @learnerId;/);
  assert.match(sql, /IF @was IN \(N'active', N'left'\) AND @was <> @status BEGIN UPDATE lms\.Learner SET Status = @status WHERE TenantId = @tenantId AND LearnerId = @learnerId; INSERT INTO lms\.AuditEvent \(EventId, TenantId, Actor, Verb, ObjectKind, ObjectId, MetaJson\) VALUES \(NEWID\(\), @tenantId, @by, 'learner\.status', 'learner',/);
  assert.match(sql, /COMMIT TRANSACTION; SELECT @was AS Was, @changed AS Changed;$/);
  assert.doesNotMatch(sql, /DELETE/i);
  assert.equal((sql.match(/UPDATE lms\.Learner/g) ?? []).length, 1);
});

test("the outcome says what happened, and a row with another status is reported, not moved", async () => {
  assert.deepEqual({ ...(await load({ Was: "active", Changed: 1 }).mod.setLearnerStatus("T", "L", "left", "a")) }, { outcome: "changed", status: "left", was: "active" });
  assert.deepEqual({ ...(await load({ Was: "left", Changed: true }).mod.setLearnerStatus("T", "L", "active", "a")) }, { outcome: "changed", status: "active", was: "left" });
  assert.deepEqual({ ...(await load({ Was: "left", Changed: 0 }).mod.setLearnerStatus("T", "L", "left", "a")) }, { outcome: "unchanged", status: "left", was: "left" });
  assert.deepEqual({ ...(await load({ Was: null, Changed: 0 }).mod.setLearnerStatus("T", "L", "left", "a")) }, { outcome: "not_found" });
  assert.deepEqual({ ...(await load(null).mod.setLearnerStatus("T", "L", "left", "a")) }, { outcome: "not_found" });
  assert.deepEqual({ ...(await load({ Was: "inactive", Changed: 0 }).mod.setLearnerStatus("T", "L", "active", "a")) }, { outcome: "other_status", status: "inactive" });
});
