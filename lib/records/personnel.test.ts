import { test } from "node:test";
import assert from "node:assert/strict";
import { LEARNER_A, LEARNER_B, recordsWorld, TENANT_A, TENANT_B } from "@/lib/fixtures/fake-records-db";
import { currentLink, PersonnelBody } from "./personnel";

// Values made in the modules' own realm (vmLoad) compared by their JSON.
const same = (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// Who a learner is at the operator (slice R2a, lms.PersonnelLink): rows from
// a date, never changed or removed; a row entered wrongly is superseded, with
// the reason, by a row of the same tenant and learner, and only once.

const body = (b: Record<string, unknown>) => {
  const parsed = PersonnelBody.safeParse(b);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  return parsed.data;
};

test("rows from later dates take over; a superseded row drops out; a future row isn't in force yet", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const add = async (b: Record<string, unknown>) => {
    const r = await world.personnel.recordPersonnelLink(TENANT_A, LEARNER_A, body(b), "admin@a.test");
    assert.equal(r.outcome, "added");
    return r.link;
  };
  const fo = await add({ dutyPosition: "pilot", employeeNo: "E100", hireDate: "2024-03-01", effectiveFrom: "2024-03-01" });
  const wrong = await add({ dutyPosition: "dispatcher", effectiveFrom: "2025-06-01" });
  const fixed = await add({ dutyPosition: "pilot", employeeNo: "E100", effectiveFrom: "2025-06-01", supersedesLinkId: wrong.personnelLinkId, reason: "Entered on the wrong learner's form." });
  await add({ dutyPosition: "pilot", employeeNo: "E100", leaveDate: "2027-01-31", effectiveFrom: "2027-01-31" });

  const links = await world.personnelLinks.listPersonnelLinks(TENANT_A, LEARNER_A);
  assert.equal(links.length, 4);
  assert.equal(currentLink(links, "2025-01-01")?.personnelLinkId, fo.personnelLinkId);
  assert.equal(currentLink(links, "2026-10-29")?.personnelLinkId, fixed.personnelLinkId);
  assert.equal(currentLink(links, "2024-01-01"), null);
  assert.equal(links.find((l: { personnelLinkId: string }) => l.personnelLinkId === fixed.personnelLinkId).reason, "Entered on the wrong learner's form.");
});

test("a row is superseded once, by the same learner's row; another tenant's learner is not found", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const first = await world.personnel.recordPersonnelLink(TENANT_A, LEARNER_A, body({ dutyPosition: "pilot", effectiveFrom: "2025-01-01" }), "a@a.test");
  const once = body({ dutyPosition: "ame", effectiveFrom: "2025-01-01", supersedesLinkId: first.link.personnelLinkId, reason: "Wrong position." });
  assert.equal((await world.personnel.recordPersonnelLink(TENANT_A, LEARNER_A, once, "a@a.test")).outcome, "added");
  same(await world.personnel.recordPersonnelLink(TENANT_A, LEARNER_A, once, "a@a.test"), { outcome: "already_superseded" });

  same(await world.personnel.recordPersonnelLink(TENANT_B, LEARNER_A, body({ dutyPosition: "pilot", effectiveFrom: "2025-01-01" }), "b@b.test"), { outcome: "not_found" });
  same(await world.personnel.recordPersonnelLink(TENANT_B, LEARNER_B, once, "b@b.test"), { outcome: "not_found" });
  same(await world.personnelLinks.listPersonnelLinks(TENANT_B, LEARNER_A), []);
  assert.equal(world.db.personnelLinks.length, 2);
});

test("the body refuses an unknown position, an impossible date, leaving before joining, and superseding without a reason", () => {
  for (const b of [
    { dutyPosition: "captain", effectiveFrom: "2025-01-01" },
    { dutyPosition: "pilot", effectiveFrom: "2025-02-30" },
    { dutyPosition: "pilot", effectiveFrom: "2025-01-01", hireDate: "2025-01-01", leaveDate: "2024-12-31" },
    { dutyPosition: "pilot", effectiveFrom: "2025-01-01", supersedesLinkId: "a1a1a1a1-0000-4000-8000-0000000000a1" },
    { dutyPosition: "pilot", effectiveFrom: "2025-01-01", medicalClass: "1" },
  ]) assert.equal(PersonnelBody.safeParse(b).success, false, JSON.stringify(b));
});

test("the table refuses any update or delete", async () => {
  const world = recordsWorld();
  await assert.rejects(world.db.module.execute("UPDATE lms.PersonnelLink SET DutyPosition = 'other'"), /append-only/);
  await assert.rejects(world.db.module.execute("DELETE FROM lms.PersonnelLink"), /never deleted/);
});
