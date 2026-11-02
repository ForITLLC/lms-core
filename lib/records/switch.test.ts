import { test } from "node:test";
import assert from "node:assert/strict";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";

// Which tenants get training records (docs/plans/2026-10-29-training-records-design.md
// §7, slice R1a). Off for every tenant until TRAINING_RECORDS_TENANTS names
// it by id or slug.

const TENANT = "0e0e0e0e-0000-4000-8000-00000000000a";
const OTHER = "0f0f0f0f-0000-4000-8000-00000000000f";
const GONE = "0d0d0d0d-0000-4000-8000-00000000000d";
const SLUGS: Record<string, string> = { [TENANT]: "Tenant-A", [OTHER]: "tenant-b" };

function load(processEnv: Record<string, string | undefined> = {}) {
  const reads: string[] = [];
  const tenants = { getTenantSlug: async (tenantId: string) => { reads.push(tenantId); return SLUGS[tenantId] ?? null; } };
  const records = vmLoad(new URL("./switch.ts", import.meta.url), { "@/lib/db/tenants": tenants }, { process: { env: processEnv } });
  return { records, reads };
}

test("unset or empty, training records are off for every tenant and no tenant is looked up", async () => {
  for (const env of [{}, { TRAINING_RECORDS_TENANTS: "" }, { TRAINING_RECORDS_TENANTS: "  " }, { TRAINING_RECORDS_TENANTS: " , ,," }]) {
    const { records, reads } = load(env);
    for (const tenantId of [TENANT, OTHER, GONE]) {
      assert.equal(await records.trainingRecordsEnabled(tenantId), false, JSON.stringify(env));
      assert.equal(await records.trainingRecordsEnabled(tenantId, env), false, JSON.stringify(env));
    }
    assert.deepEqual(reads, []);
  }
});

test("a listed tenant id turns them on without a lookup, matched whole and without regard to case", async () => {
  const { records, reads } = load();
  const on = (tenantId: string, list: string) => records.trainingRecordsEnabled(tenantId, { TRAINING_RECORDS_TENANTS: list });
  assert.equal(await on(TENANT, TENANT), true);
  assert.equal(await on(TENANT.toUpperCase(), ` ${TENANT} , ${GONE}`), true);
  assert.equal(await on(TENANT, TENANT.toUpperCase()), true);
  assert.deepEqual(reads, []);
  assert.equal(await on(TENANT, TENANT.slice(0, 35)), false, "a prefix of the id");
  assert.equal(await on(OTHER, TENANT), false);
});

test("a listed slug turns them on for that tenant only", async () => {
  const { records, reads } = load();
  const on = (tenantId: string, list: string) => records.trainingRecordsEnabled(tenantId, { TRAINING_RECORDS_TENANTS: list });
  assert.equal(await on(TENANT, "tenant-a"), true);
  assert.equal(await on(TENANT, " TENANT-A , tenant-c"), true);
  assert.equal(await on(OTHER, "tenant-a"), false);
  assert.equal(await on(OTHER, "tenant-a,tenant-b"), true);
  for (const list of ["tenant", "tenant-a-x", "tenant-*", "*", "tenant-a;tenant-b"]) {
    assert.equal(await on(TENANT, list), false, list);
  }
  assert.equal(await on(GONE, "tenant-a,tenant-b"), false, "an inactive or unknown tenant has no slug");
  assert.equal(reads.length, 10);
});

test("with no env passed it reads the process's TRAINING_RECORDS_TENANTS", async () => {
  assert.equal(await load({ TRAINING_RECORDS_TENANTS: "tenant-a" }).records.trainingRecordsEnabled(TENANT), true);
  assert.equal(await load({ AI_AUTHORING_TENANTS: "tenant-a" }).records.trainingRecordsEnabled(TENANT), false, "the AI switch is a different switch");
});
