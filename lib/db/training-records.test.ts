import { test } from "node:test";
import assert from "node:assert/strict";
import { GENESIS_HASH, verifyChain } from "@/lib/records/chain";
import {
  COURSE, COURSE_TITLE, LEARNER_A, LEARNER_A2, LEARNER_B, PRACTICE_QUIZ, QUIZ, recordsWorld, TENANT_A, TENANT_B, VERSION,
} from "@/lib/fixtures/fake-records-db";

// lms.TrainingRecord and its chain head (migration 0034; slice R1a of
// docs/plans/2026-10-29-training-records-design.md). Every statement names
// the tenant, each tenant's records count from Seq 1 on a chain of their own,
// and two writers racing for the same tenant can't fork it.

const AT = new Date("2026-10-29T10:00:00.000Z");
const completion = (learnerId: string, over: Record<string, unknown> = {}) => ({
  learnerId, kind: "course_completion", occurredAt: AT, result: "completed", source: "auto", recordedBy: "pilot@example.test",
  courseId: COURSE, courseVersionId: VERSION, courseTitle: COURSE_TITLE, ...over,
});
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("each tenant's records count from Seq 1 on a chain of their own, and come back as they were stored", async () => {
  const world = recordsWorld();
  const appended: any[] = [];
  for (const [tenantId, learnerId] of [[TENANT_A, LEARNER_A], [TENANT_B, LEARNER_B], [TENANT_A, LEARNER_A2], [TENANT_A, LEARNER_A], [TENANT_B, LEARNER_B]] as const) {
    appended.push(await world.records.appendTrainingRecord(tenantId, completion(learnerId)));
  }
  assert.deepEqual(appended.map((r) => `${r.tenantId === TENANT_A ? "A" : "B"}${r.seq}`), ["A1", "B1", "A2", "A3", "B2"]);
  assert.equal(appended[0].prevHash, GENESIS_HASH);
  assert.equal(appended[1].prevHash, GENESIS_HASH, "the second tenant's chain starts at genesis too");
  assert.equal(appended[2].prevHash, appended[0].rowHash);
  assert.equal(appended[4].prevHash, appended[1].rowHash);
  assert.equal(appended[2].personName, "Pilot A2", "the person is copied from lms.Learner");
  assert.equal(appended[2].personEmail, "pilot.a2@example.test");

  for (const [tenantId, count] of [[TENANT_A, 3], [TENANT_B, 2]] as const) {
    const { rows, head } = await world.records.readChain(tenantId);
    assert.equal(rows.length, count);
    assert.ok(rows.every((r: { tenantId: string }) => r.tenantId === tenantId));
    assert.ok(rows.every((r: { seq: unknown }) => typeof r.seq === "number"), "BIGINT comes back a string and is read as a number");
    assert.deepEqual(plain(verifyChain(rows, head)), { ok: true, count, headSeq: count, headHash: rows.at(-1).rowHash });
    assert.deepEqual(plain(rows), plain(appended.filter((r) => r.tenantId === tenantId)), "read back exactly as appended");
  }
});

test("every statement names the tenant, and the append takes the chain head under UPDLOCK, HOLDLOCK", async () => {
  const world = recordsWorld();
  world.enroll(LEARNER_A, TENANT_A, AT);
  const attemptId = world.attempt(LEARNER_A);
  await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A));
  await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A));
  await world.records.listTrainingRecords(TENANT_A, { learnerId: LEARNER_A, kind: "course_completion", attemptId, from: AT, to: new Date(), limit: 5 });
  await world.records.readChain(TENANT_A);
  await world.records.readCompletionContext(TENANT_A, LEARNER_A, COURSE);
  await world.records.readAttemptContext(TENANT_A, attemptId);

  assert.ok(world.db.statements.length >= 10, "known positive: the statements were seen");
  for (const s of world.db.statements) {
    assert.equal(s.params.tenantId, TENANT_A, s.sql.slice(0, 80));
    assert.match(s.sql, /\bTenantId = @tenantId\b/, s.sql.slice(0, 80));
  }
  const appends = world.db.statements.filter((s) => s.sql.includes("INSERT INTO lms.TrainingRecord ("));
  assert.equal(appends.length, 2);
  for (const s of appends) {
    assert.equal(s.sql.match(/lms\.TrainingRecordChain WITH \(UPDLOCK, HOLDLOCK\) WHERE TenantId = @tenantId/g)?.length, 2);
    assert.match(s.sql, /^SET XACT_ABORT ON; BEGIN TRANSACTION;.*COMMIT TRANSACTION;/);
    assert.match(s.sql, /SELECT 1 FROM lms\.Learner WHERE LearnerId = @learnerId AND TenantId = @tenantId/);
    assert.match(s.sql, /UPDATE lms\.TrainingRecordChain SET .* WHERE TenantId = @tenantId;/);
  }
  assert.equal(world.db.statements.some((s) => /^(UPDATE|DELETE|MERGE) lms\.TrainingRecord\b/.test(s.sql)), false, "nothing updates or deletes a record");
});

test("another tenant's learner, or a correction of another tenant's record, appends nothing", async () => {
  const world = recordsWorld();
  const own = await world.records.appendTrainingRecord(TENANT_B, completion(LEARNER_B));
  assert.ok(own, "known positive: tenant B's own learner is recorded");

  assert.equal(await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_B)), null);
  assert.equal(await world.records.appendTrainingRecord(TENANT_A, completion("99999999-0000-4000-8000-000000000099")), null);
  assert.equal(await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A, { correctsRecordId: own.recordId })), null);
  assert.equal(world.db.records.length, 1);
  assert.deepEqual(world.db.chain.map((c) => c.TenantId), [TENANT_B], "no chain was started for tenant A");

  const correction = await world.records.appendTrainingRecord(
    TENANT_B, completion(LEARNER_B, { correctsRecordId: own.recordId, payloadJson: JSON.stringify({ correctionReason: "Wrong course." }) }),
  );
  assert.equal(correction.correctsRecordId, own.recordId, "known positive: a correction of the tenant's own record is appended");
  assert.equal(correction.seq, 2);
});

test("two writers racing on one tenant both land, one after the other, on one unforked chain", async () => {
  const world = recordsWorld();
  const results = await Promise.all([
    world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A)),
    world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A2)),
    world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A)),
  ]);
  assert.deepEqual(results.map((r) => r.seq).sort(), [1, 2, 3]);
  const lost = world.db.statements.filter((s) => s.sql.startsWith("SET XACT_ABORT ON")).length;
  assert.ok(lost > 3, `known positive: a writer lost the race and tried again (${lost} appends for 3 records)`);
  const { rows, head } = await world.records.readChain(TENANT_A);
  assert.equal(verifyChain(rows, head).ok, true);
});

test("a deadlock victim tries again; any other database error is thrown and writes nothing", async () => {
  const world = recordsWorld();
  let deadlocks = 1;
  world.db.faults.before = (sql) => {
    if (sql.startsWith("SET XACT_ABORT ON") && deadlocks-- > 0) return Object.assign(new Error("deadlock victim"), { number: 1205 });
    return undefined;
  };
  const record = await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A));
  assert.equal(record.seq, 1);
  assert.equal(world.db.records.length, 1);

  world.db.faults.before = (sql) => (sql.startsWith("SET XACT_ABORT ON") ? Object.assign(new Error("connection reset"), { number: 10054 }) : undefined);
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A)), /connection reset/);
  assert.equal(world.db.records.length, 1);
});

test("a chain that moves under every try gives up after APPEND_TRIES and appends nothing", async () => {
  const world = recordsWorld();
  await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A));
  let moves = 0;
  world.db.faults.before = (sql) => {
    if (sql.startsWith("SET XACT_ABORT ON")) {
      world.db.chain[0]!.LastSeq += 1;
      moves += 1;
    }
    return undefined;
  };
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A)), /stayed busy for 20 tries/);
  assert.equal(moves, world.records.APPEND_TRIES);
  assert.equal(world.db.records.length, 1);
  assert.equal(world.waits.length, world.records.APPEND_TRIES - 1, "a wait before every try but the first");
  assert.ok(world.waits.every((ms) => ms >= 0 && ms < world.records.APPEND_WAIT_MS.cap));
});

test("the wait before a retry is random, can double each time from 10 ms, and stops growing at 1 s", () => {
  const { appendWaitMs } = recordsWorld().records;
  const most = () => 0.999999;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8, 19].map((retry) => appendWaitMs(retry, most)), [9, 19, 39, 79, 159, 319, 639, 999, 999]);
  assert.deepEqual([1, 6, 19].map((retry) => appendWaitMs(retry, () => 0)), [0, 0, 0]);
  assert.equal(appendWaitMs(4, () => 0.5), 40);
  const drawn = Array.from({ length: 200 }, () => appendWaitMs(3));
  assert.ok(drawn.every((ms) => Number.isInteger(ms) && ms >= 0 && ms < 40));
  assert.ok(new Set(drawn).size > 5, "known positive: the default draws from Math.random");
});

test("twenty writers bursting on one tenant all land on one unforked chain, without waiting before a first try", async () => {
  const world = recordsWorld();
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    world.records.appendTrainingRecord(TENANT_A, completion(i % 2 ? LEARNER_A : LEARNER_A2))));
  assert.deepEqual(results.map((r) => r.seq).sort((a: number, b: number) => a - b), Array.from({ length: 20 }, (_, i) => i + 1));
  const tries = world.db.statements.filter((s) => s.sql.startsWith("SET XACT_ABORT ON")).length;
  assert.ok(tries > 20, `known positive: writers lost the race and tried again (${tries} appends for 20 records)`);
  assert.equal(world.waits.length, tries - 20, "one wait per retry, none before a writer's first try");
  const { rows, head } = await world.records.readChain(TENANT_A);
  assert.deepEqual(plain(verifyChain(rows, head)), { ok: true, count: 20, headSeq: 20, headHash: rows.at(-1).rowHash });
  assert.equal(new Set(rows.map((r: { prevHash: string }) => r.prevHash)).size, 20, "no two records chain from the same hash");
});

test("the database refuses a fail with no failure detail and a pass below the passing score, and keeps nothing of the batch", async () => {
  const world = recordsWorld();
  const exam = (over: Record<string, unknown>) => completion(LEARNER_A, { kind: "exam_fail", result: "fail", score: 40, passingScore: 70, quizId: QUIZ, ...over });
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, exam({ failureDetail: null })), /CK_lms_TrainingRecord_FailureDetail/);
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, exam({ kind: "exam_pass", result: "pass", failureDetail: null })), /CK_lms_TrainingRecord_Score/);
  await assert.rejects(world.records.appendTrainingRecord(TENANT_A, exam({ kind: "exam_pass", result: "fail", failureDetail: "x" })), /CK_lms_TrainingRecord_KindResult/);
  assert.equal(world.db.records.length, 0);
  assert.equal(world.db.chain.length, 0, "the chain head created in the failed batch was rolled back");
  const ok = await world.records.appendTrainingRecord(TENANT_A, exam({ failureDetail: "scored 40, needed 70" }));
  assert.equal(ok.seq, 1, "known positive: the same record with its detail is appended");
});

test("the list is the tenant's own, newest first, filtered and capped", async () => {
  const world = recordsWorld();
  const days = ["2026-10-01", "2026-10-03", "2026-10-02"];
  for (const day of days) await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A, { occurredAt: new Date(`${day}T08:00:00.000Z`) }));
  await world.records.appendTrainingRecord(TENANT_A, completion(LEARNER_A2, { occurredAt: new Date("2026-10-04T08:00:00.000Z") }));
  await world.records.appendTrainingRecord(TENANT_B, completion(LEARNER_B, { occurredAt: new Date("2026-10-05T08:00:00.000Z") }));

  const list = async (filters: Record<string, unknown> = {}) =>
    (await world.records.listTrainingRecords(TENANT_A, filters)).map((r: { occurredAt: Date }) => r.occurredAt.toISOString().slice(0, 10));
  assert.deepEqual(await list(), ["2026-10-04", "2026-10-03", "2026-10-02", "2026-10-01"]);
  assert.deepEqual(await list({ learnerId: LEARNER_A }), ["2026-10-03", "2026-10-02", "2026-10-01"]);
  assert.deepEqual(await list({ from: new Date("2026-10-02T00:00:00Z"), to: new Date("2026-10-04T00:00:00Z") }), ["2026-10-03", "2026-10-02"]);
  assert.deepEqual(await list({ limit: 2 }), ["2026-10-04", "2026-10-03"]);
  assert.deepEqual(await list({ kind: "exam_pass" }), []);
  const limits = world.db.statements.filter((s) => s.sql.includes("TOP (@limit)")).map((s) => s.params.limit);
  assert.deepEqual(limits, [500, 500, 500, 2, 500]);
  await world.records.listTrainingRecords(TENANT_A, { limit: 10_000 });
  await world.records.listTrainingRecords(TENANT_A, { limit: 0 });
  assert.deepEqual(world.db.statements.slice(-2).map((s) => s.params.limit), [500, 1]);
});

test("the writers' reads see only the tenant's own learner, and only a completed enrollment or a submitted attempt", async () => {
  const world = recordsWorld();
  world.enroll(LEARNER_A, TENANT_A, AT, 2);
  world.enroll(LEARNER_A2, TENANT_A, null);
  world.enroll(LEARNER_B, TENANT_B, AT);
  const mine = world.attempt(LEARNER_A);
  const theirs = world.attempt(LEARNER_B);

  assert.deepEqual(plain(await world.records.readCompletionContext(TENANT_A, LEARNER_A, COURSE)), {
    learnerEmail: "pilot.a@example.test", courseId: COURSE, versionId: VERSION, courseTitle: COURSE_TITLE, completedAt: AT.toISOString(), cycleNo: 2,
  });
  assert.equal(await world.records.readCompletionContext(TENANT_A, LEARNER_A2, COURSE), null, "not completed");
  assert.equal(await world.records.readCompletionContext(TENANT_A, LEARNER_B, COURSE), null, "another tenant's learner");

  assert.deepEqual(plain(await world.records.readAttemptContext(TENANT_A, mine)), {
    learnerId: LEARNER_A, learnerEmail: "pilot.a@example.test", quizId: QUIZ, courseId: COURSE, versionId: VERSION,
    courseTitle: COURSE_TITLE, submittedAt: "2026-10-29T09:00:00.000Z", isExam: true,
  });
  const practice = world.attempt(LEARNER_A, undefined, PRACTICE_QUIZ);
  assert.equal((await world.records.readAttemptContext(TENANT_A, practice))?.isExam, false, "a practice quiz's attempt reads as no exam");
  assert.equal(await world.records.readAttemptContext(TENANT_A, theirs), null, "another tenant's attempt");
  assert.ok(await world.records.readAttemptContext(TENANT_B, theirs), "known positive: tenant B reads its own");
});
