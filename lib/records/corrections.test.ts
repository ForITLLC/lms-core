import { test } from "node:test";
import assert from "node:assert/strict";
import { COURSE, LEARNER_A, LEARNER_A2, recordsWorld, TENANT_A, TENANT_B } from "@/lib/fixtures/fake-records-db";
import { verifyChain } from "./chain";
import { checkEntry } from "./manual";

// Values made in the modules' own realm (vmLoad) compared by their JSON.
const same = (actual: unknown, expected: unknown, message?: string) => assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected, message);

// Correcting a training record (slice R2a): a correction is a new record
// naming the one it corrects, so the original, the reason and who made the
// change all stay; a record is corrected once, by a record of the same
// tenant and learner; an automatic record changes only its date and title.

const NOW = new Date("2026-10-29T12:00:00.000Z");
const OJT = {
  kind: "ojt", title: "Line OJT sector 4", occurredOn: "2026-09-12", result: "completed",
  instructorName: "I. Instructor", evidenceRef: "OJT book p.12",
};

async function withRecord(entry: Record<string, unknown> = OJT) {
  const world = recordsWorld({ tenants: "tenant-a" });
  const checked = checkEntry(entry, NOW);
  assert.ok(checked.ok);
  const original = await world.manual.recordManualEntry(TENANT_A, LEARNER_A, checked.entry, "first.admin@a.test");
  return { world, original };
}

test("a correction keeps the original, carries the reason and names who made it", async () => {
  const { world, original } = await withRecord();
  const result = await world.corrections.correctRecord(
    TENANT_A, original.recordId, { reason: "Wrong date: the sector flew on the 13th.", changes: { occurredOn: "2026-09-13" } }, "second.admin@a.test", NOW,
  );
  assert.equal(result.outcome, "corrected");
  const fixed = result.record;
  assert.equal(fixed.correctsRecordId, original.recordId);
  assert.equal(fixed.recordedBy, "second.admin@a.test");
  assert.equal(fixed.occurredAt.toISOString(), "2026-09-13T00:00:00.000Z");
  assert.equal(fixed.courseTitle, "Line OJT sector 4");
  same(JSON.parse(fixed.payloadJson), {
    instructorName: "I. Instructor", evidenceRef: "OJT book p.12", correctionReason: "Wrong date: the sector flew on the 13th.",
  });

  assert.equal(world.db.records.length, 2);
  const kept = world.db.records.find((r) => r.RecordId === original.recordId)!;
  assert.equal(new Date(kept.OccurredAt).toISOString(), "2026-09-12T00:00:00.000Z");
  assert.equal(kept.RecordedBy, "first.admin@a.test");

  const all = await world.records.readLearnerRecords(TENANT_A, LEARNER_A);
  same(world.corrections.currentRecords(all).map((r: { recordId: string }) => r.recordId), [fixed.recordId]);
  same(world.corrections.correctionLine(all, fixed.recordId).map((r: { recordId: string }) => r.recordId), [original.recordId, fixed.recordId]);
  same(world.corrections.correctionLine(all, original.recordId).map((r: { recordId: string }) => r.recordId), [original.recordId, fixed.recordId]);
  const { rows, head } = await world.records.readChain(TENANT_A);
  assert.equal(verifyChain(rows, head).ok, true);
});

test("a record is corrected once: correcting it again answers the record in force, and the line can go on from there", async () => {
  const { world, original } = await withRecord();
  const first = await world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "Typo", changes: { title: "Line OJT sector 5" } }, "a@a.test", NOW);
  assert.equal(first.outcome, "corrected");
  const again = await world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "Again", changes: { title: "X" } }, "a@a.test", NOW);
  same(again, { outcome: "already_corrected", currentRecordId: first.record.recordId });
  const second = await world.corrections.correctRecord(TENANT_A, first.record.recordId, { reason: "Typo again", changes: { title: "Line OJT sector 6" } }, "a@a.test", NOW);
  assert.equal(second.outcome, "corrected");
  const all = await world.records.readLearnerRecords(TENANT_A, LEARNER_A);
  same(world.corrections.correctionLine(all, original.recordId).map((r: { courseTitle: string }) => r.courseTitle), [
    "Line OJT sector 4", "Line OJT sector 5", "Line OJT sector 6",
  ]);
});

test("two corrections racing on one record: the database lets one land and the other hears the one in force", async () => {
  const { world, original } = await withRecord();
  const [a, b] = await Promise.all([
    world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "A", changes: { title: "A" } }, "a@a.test", NOW),
    world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "B", changes: { title: "B" } }, "b@a.test", NOW),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  same(outcomes, ["already_corrected", "corrected"]);
  assert.equal(world.db.records.filter((r) => r.CorrectsRecordId !== null).length, 1);
});

test("voiding keeps every field, marks the record void and drops it from the records in force", async () => {
  const { world, original } = await withRecord();
  const result = await world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "Entered against the wrong person.", void: true }, "a@a.test", NOW);
  assert.equal(result.outcome, "corrected");
  assert.equal(result.record.result, "completed");
  assert.equal(result.record.courseTitle, "Line OJT sector 4");
  assert.equal(world.corrections.recordView(result.record).void, true);
  const all = await world.records.readLearnerRecords(TENANT_A, LEARNER_A);
  same(world.corrections.currentRecords(all), []);
  const both = await world.corrections.correctRecord(TENANT_A, result.record.recordId, { reason: "x", void: true, changes: { title: "y" } }, "a@a.test", NOW);
  assert.equal(both.outcome, "invalid");
  const nothing = await world.corrections.correctRecord(TENANT_A, result.record.recordId, { reason: "x" }, "a@a.test", NOW);
  assert.equal(nothing.outcome, "invalid");
});

test("a corrected record is checked by the entry rules: a change to fail needs its detail", async () => {
  const { world, original } = await withRecord({ ...OJT, kind: "check", result: "pass", checkType: "line_check" });
  const bare = await world.corrections.correctRecord(TENANT_A, original.recordId, { reason: "It was a fail.", changes: { result: "fail" } }, "a@a.test", NOW);
  assert.equal(bare.outcome, "invalid");
  same(bare.issues.map((i: { field: string }) => i.field), ["failureDetail"]);
  const full = await world.corrections.correctRecord(
    TENANT_A, original.recordId, { reason: "It was a fail.", changes: { result: "fail", failureDetail: "Unstable approach continued." } }, "a@a.test", NOW,
  );
  assert.equal(full.outcome, "corrected");
  assert.equal(JSON.parse(full.record.payloadJson).checkType, "line_check");
});

test("an automatic record changes only its date and title; its result changes only through marking", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  world.enroll(LEARNER_A, TENANT_A, new Date("2026-10-20T10:00:00.000Z"));
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), true);
  const auto = (await world.records.readLearnerRecords(TENANT_A, LEARNER_A))[0];
  const refused = await world.corrections.correctRecord(TENANT_A, auto.recordId, { reason: "x", changes: { result: "fail", failureDetail: "y" } }, "a@a.test", NOW);
  assert.equal(refused.outcome, "invalid");
  same(refused.issues.map((i: { field: string }) => i.field).sort(), ["failureDetail", "result"]);
  const dated = await world.corrections.correctRecord(TENANT_A, auto.recordId, { reason: "Clock was wrong.", changes: { occurredOn: "2026-10-19" } }, "a@a.test", NOW);
  assert.equal(dated.outcome, "corrected");
  assert.equal(dated.record.kind, "course_completion");
  assert.equal(dated.record.result, "completed");
  assert.equal(dated.record.courseId, COURSE);
  assert.equal(dated.record.source, "manual");
  assert.equal(JSON.parse(dated.record.payloadJson).cycleNo, 1);
});

test("another tenant's record is not found, and the database refuses a correction that names another learner or has no reason", async () => {
  const { world, original } = await withRecord();
  same(await world.corrections.correctRecord(TENANT_B, original.recordId, { reason: "x", changes: { title: "y" } }, "b@b.test", NOW), { outcome: "not_found" });
  assert.equal(world.db.records.length, 1);

  const checked = checkEntry(OJT, NOW);
  assert.ok(checked.ok);
  const input = world.manual.entryRecordInput(LEARNER_A2, checked.entry, "manual", "a@a.test", { correctionReason: "x" });
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, { ...input, correctsRecordId: original.recordId }), /FK_lms_TrainingRecord_CorrectsSamePerson/);
  const noReason = world.manual.entryRecordInput(LEARNER_A, checked.entry, "manual", "a@a.test");
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, { ...noReason, correctsRecordId: original.recordId }), /CK_lms_TrainingRecord_CorrectionReason/);
  assert.equal(world.db.records.length, 1);
});
