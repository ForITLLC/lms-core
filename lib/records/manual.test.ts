import { test } from "node:test";
import assert from "node:assert/strict";
import { LEARNER_A, LEARNER_B, recordsWorld, TENANT_A } from "@/lib/fixtures/fake-records-db";
import { verifyChain } from "./chain";
import { checkEntry, entryPayload } from "./manual";

// Values made in the modules' own realm (vmLoad) compared by their JSON.
const same = (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// Training records entered by hand (slice R2a): every one names its
// instructor or assessor and its evidence, a fail says what was failed, and
// each joins the tenant's hash chain as the admin who entered it.

const NOW = new Date("2026-10-29T12:00:00.000Z");
const CHECK = {
  kind: "check",
  title: "PPC, DHC-8",
  occurredOn: "2026-10-01",
  result: "pass",
  checkType: "ppc",
  assessorName: "A. Assessor",
  evidenceRef: "PFTR 2026-0412",
  aircraftType: "DHC-8",
};
const fields = (issues: { field: string }[]) => issues.map((i) => i.field).sort();

test("a complete entry passes, with its date at midnight UTC", () => {
  const checked = checkEntry(CHECK, NOW);
  assert.ok(checked.ok);
  assert.equal(checked.entry.occurredAt.toISOString(), "2026-10-01T00:00:00.000Z");
  assert.equal(checked.entry.assessorName, "A. Assessor");
});

test("a fail with no detail, no instructor or assessor, or no evidence is refused", () => {
  const fail = checkEntry({ ...CHECK, result: "fail" }, NOW);
  assert.ok(!fail.ok);
  same(fields(fail.issues), ["failureDetail"]);
  assert.ok(checkEntry({ ...CHECK, result: "fail", failureDetail: "Engine failure after V1 flown outside limits." }, NOW).ok);

  const nobody = checkEntry({ ...CHECK, assessorName: "  " }, NOW);
  assert.ok(!nobody.ok);
  same(fields(nobody.issues), ["instructorName"]);

  const noEvidence = checkEntry({ ...CHECK, evidenceRef: "" }, NOW);
  assert.ok(!noEvidence.ok);
  same(fields(noEvidence.issues), ["evidenceRef"]);
});

test("dates must exist, fall after 1950 and not be in the future; scores must agree with the result", () => {
  for (const [occurredOn, message] of [
    ["2026-02-30", /doesn't exist/],
    ["01/10/2026", /YYYY-MM-DD/],
    ["1949-12-31", /before 1950/],
    ["2026-11-01", /future/],
  ] as const) {
    const checked = checkEntry({ ...CHECK, occurredOn }, NOW);
    assert.ok(!checked.ok, occurredOn);
    assert.match(checked.issues[0]!.message, message);
  }
  assert.ok(checkEntry({ ...CHECK, occurredOn: "2026-10-30" }, NOW).ok, "a day ahead covers every time zone's today");
  const low = checkEntry({ ...CHECK, score: 60, passingScore: 70 }, NOW);
  assert.ok(!low.ok);
  same(fields(low.issues), ["score"]);
  const typed = checkEntry({ ...CHECK, kind: "ojt", checkType: "ppc" }, NOW);
  assert.ok(!typed.ok);
  same(fields(typed.issues), ["checkType"]);
  const extra = checkEntry({ ...CHECK, licenceNo: "123" }, NOW);
  assert.ok(!extra.ok, "unknown fields are refused, so no licence or medical detail slips in");
});

test("the payload keeps its details in one order, whatever order they came in", () => {
  const a = entryPayload({ evidenceRef: "E", instructorName: "I", aircraftType: "T" }, { importRow: 2 });
  const b = entryPayload({ aircraftType: "T", instructorName: "I", evidenceRef: "E" }, { importRow: 2 });
  assert.equal(a, b);
  assert.equal(a, '{"instructorName":"I","evidenceRef":"E","aircraftType":"T","importRow":2}');
});

test("an entry is appended to the tenant's chain as the admin who entered it; another tenant's learner is refused", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const checked = checkEntry(CHECK, NOW);
  assert.ok(checked.ok);
  const record = await world.manual.recordManualEntry(TENANT_A, LEARNER_A, checked.entry, "admin@a.test");
  assert.equal(record.source, "manual");
  assert.equal(record.recordedBy, "admin@a.test");
  assert.equal(record.kind, "check");
  assert.equal(record.courseTitle, "PPC, DHC-8");
  same(JSON.parse(record.payloadJson), {
    assessorName: "A. Assessor", evidenceRef: "PFTR 2026-0412", checkType: "ppc", aircraftType: "DHC-8",
  });
  assert.equal(await world.manual.recordManualEntry(TENANT_A, LEARNER_B, checked.entry, "admin@a.test"), null);
  assert.equal(world.db.records.length, 1);
  const { rows, head } = await world.records.readChain(TENANT_A);
  assert.equal(verifyChain(rows, head).ok, true);
});
