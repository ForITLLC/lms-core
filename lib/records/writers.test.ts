import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gradingWorld, LEARNER_A as G_LEARNER, Q_MCQ, Q_SHORT, QUIZ as G_QUIZ, TENANT as G_TENANT, vmLoad } from "@/lib/fixtures/fake-grading-db";
import {
  BLOCK, COURSE, COURSE_TITLE, fakeRecordsDb, LEARNER_A, LEARNER_B, PRACTICE_QUIZ, QUIZ, recordsWorld, TENANT_A, VERSION,
} from "@/lib/fixtures/fake-records-db";
import { verifyChain } from "./chain";

// The automatic training-record writers (docs/plans/2026-10-29-training-records-design.md
// §3.2, slice R1a): a completed course, a decided exam attempt, and an
// instructor's mark that decides an attempt or turns its pass into a fail or
// back. A submitted attempt whose written answers still wait for an
// instructor is recorded as pending, never as a fail. They write only for
// tenants TRAINING_RECORDS_TENANTS lists, and they never fail the learner's
// or the instructor's request.

const AT = new Date("2026-10-29T10:00:00.000Z");
const SUBMITTED = new Date("2026-10-29T09:00:00.000Z");
const Q1 = "f1f1f1f1-0000-4000-8000-0000000000f1";
const Q2 = "f2f2f2f2-0000-4000-8000-0000000000f2";
const Q3 = "f3f3f3f3-0000-4000-8000-0000000000f3";
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

// One auto-marked question (Q1) and, unless `auto` says otherwise, written ones.
function submitted(score: number, written: number) {
  const perQuestion = [
    { questionId: Q1, orderIndex: 0, autoGradable: true, correct: score >= 50 },
    ...[Q2, Q3].slice(0, written).map((questionId, i) => ({ questionId, orderIndex: i + 1, autoGradable: false, correct: null })),
  ];
  return { grade: { score, autoGradableCount: 1, correctCount: score >= 50 ? 1 : 0, perQuestion } };
}

const record = (world: ReturnType<typeof recordsWorld>, i = 0) => world.db.records[i]!;

test("with the switch off, or the tenant not listed, nothing is read or written and no tenant is looked up when it is off", async () => {
  for (const tenants of [undefined, "", "tenant-b"]) {
    const world = recordsWorld({ tenants });
    world.enroll(LEARNER_A, TENANT_A, AT);
    const attemptId = world.attempt(LEARNER_A);
    const attempt = { attemptId, score: 100, passingScore: 70, passed: true };
    assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), false);
    assert.equal(await world.writers.recordExamAttempt(TENANT_A, attempt, submitted(100, 0).grade, ["a"]), false);
    assert.equal(await world.writers.recordExamMark(TENANT_A, {
      attemptId, gradeId: Q3, by: "staff@example.test", passingScore: 70, answers: [{ questionId: Q1, responseJson: '"a"' }],
      before: { score: 100, answers: [{ questionId: Q1, decidesPass: true }] }, after: { score: 0, answers: [{ questionId: Q1, decidesPass: true }] },
    }), false);
    assert.deepEqual(world.db.statements, [], String(tenants));
    assert.deepEqual(world.lines, []);
    assert.equal(world.slugReads.length, tenants === "tenant-b" ? 3 : 0, String(tenants));
  }
});

test("a completed course is recorded once, as the learner's own, with its cycle", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  world.enroll(LEARNER_A, TENANT_A, AT, 2);
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), true);
  assert.deepEqual(
    plain({ ...record(world), RecordId: undefined, RecordedAt: undefined, RowHash: undefined }),
    plain({
      TenantId: TENANT_A, Seq: 1, LearnerId: LEARNER_A, PersonName: "Pilot A", PersonEmail: "pilot.a@example.test",
      Kind: "course_completion", OccurredAt: AT, CourseId: COURSE, CourseVersionId: VERSION, CourseTitle: COURSE_TITLE,
      QuizId: null, AttemptId: null, Result: "completed", Score: null, PassingScore: null, FailureDetail: null, Source: "auto",
      RecordedBy: "pilot.a@example.test", CorrectsRecordId: null, PayloadJson: '{"cycleNo":2}', PrevHash: "0".repeat(64),
    }),
  );

  world.enroll(LEARNER_B, "bbbbbbbb-0000-4000-8000-00000000000b", AT);
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_B, COURSE), false, "another tenant's learner");
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, "a2a2a2a2-0000-4000-8000-0000000000a2", COURSE), false, "not enrolled");
  assert.equal(world.db.records.length, 1);
  assert.deepEqual(world.lines, []);
});

test("the course-finish hook records only for the call that stamped the completion", async () => {
  for (const stamped of [true, false]) {
    const calls: string[] = [];
    const finish = vmLoad(new URL("../db/course-finish.ts", import.meta.url), {
      "@/lib/db": { queryOne: async () => ({ Pending: 0 }) },
      "@/lib/db/progress": {
        getCourseProgress: async () => ({ completed: true, totalBlocks: 1, completedBlocks: 1, pct: 100 }),
        completeEnrollment: async () => { calls.push("complete"); return stamped; },
      },
      "@/lib/db/quizzes": { courseRequiresQuizPass: async () => false },
      "@/lib/db/certificates": { issueCertificate: async () => { calls.push("certificate"); return { SerialNo: "CERT" }; } },
      "@/lib/records/writers": { recordCourseCompletion: async (...args: string[]) => { calls.push(`record:${args.join(":")}`); return true; } },
    });
    await finish.finishCourseIfDone("T", "L", "Learner", "C", { totalQuizzes: 0, passedQuizzes: 0, passed: true, quizzes: [] });
    assert.deepEqual(calls, stamped ? ["complete", "record:T:L:C", "certificate"] : ["complete", "certificate"], `stamped ${stamped}`);
  }
});

test("a decided attempt is a pass or a fail with its score; a fail says why", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  for (const [score, kind] of [[100, "exam_pass"], [70, "exam_pass"], [0, "exam_fail"]] as const) {
    const attemptId = world.attempt(LEARNER_A, SUBMITTED);
    const ok = await world.writers.recordExamAttempt(TENANT_A, { attemptId, score, passingScore: 70, passed: score >= 70 }, submitted(score, 0).grade, ["a"]);
    assert.equal(ok, true);
    const r = world.db.records.at(-1)!;
    assert.deepEqual(
      [r.Kind, r.Result, r.Score, r.PassingScore, r.FailureDetail, r.AttemptId, r.QuizId, r.OccurredAt.toISOString(), r.RecordedBy, r.PayloadJson],
      [kind, kind === "exam_pass" ? "pass" : "fail", score, 70, kind === "exam_fail" ? `scored ${score}, needed 70` : null, attemptId,
        world.db.quizzes[0]!.QuizId, SUBMITTED.toISOString(), "pilot.a@example.test", null],
    );
  }
  const { rows, head } = await world.records.readChain(TENANT_A);
  assert.equal(verifyChain(rows, head).ok, true);
});

test("an attempt whose written answer waits for an instructor is pending, never a fail, whatever its score so far", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  for (const [score, responses, awaiting] of [[0, ["b", "Lift is pressure"], 1], [100, ["a", "Lift"], 1], [0, ["b", "Lift", "  "], 2]] as const) {
    const attemptId = world.attempt(LEARNER_A, SUBMITTED);
    const { grade } = submitted(score, responses.length - 1);
    assert.equal(await world.writers.recordExamAttempt(TENANT_A, { attemptId, score, passingScore: 70, passed: score >= 70 }, grade, responses), true);
    const r = world.db.records.at(-1)!;
    assert.deepEqual([r.Kind, r.Result, r.Score, r.PassingScore, r.FailureDetail, r.PayloadJson],
      ["exam_attempt_pending", "pending", null, 70, null, JSON.stringify({ awaitingMarks: awaiting })], JSON.stringify(responses));
  }
  assert.equal(world.db.records.some((r) => r.Result === "fail"), false);
});

test("a blank written answer is never listed for marking, so it holds nothing open", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  for (const responses of [["b", ""], ["b", null], ["b"]]) {
    const attemptId = world.attempt(LEARNER_A, SUBMITTED);
    await world.writers.recordExamAttempt(TENANT_A, { attemptId, score: 0, passingScore: 70, passed: false }, submitted(0, 1).grade, responses);
    assert.deepEqual([world.db.records.at(-1)!.Kind, world.db.records.at(-1)!.FailureDetail], ["exam_fail", "scored 0, needed 70"], JSON.stringify(responses));
  }
});

test("the unlisted answers are the staff marking queue's own: lib/db/answer-grades.ts, the awaiting-answers statement", async () => {
  const world = recordsWorld();
  const source = readFileSync(new URL("../db/answer-grades.ts", import.meta.url), "utf8");
  const filter = /r\.MachineScore IS NULL AND r\.ResponseJson NOT IN \(([^)]*)\)/.exec(source);
  assert.ok(filter, "the staff queue lists written answers by ResponseJson");
  const listed = filter[1]!.split(",").map((s) => s.trim().replace(/^N'/, "").replace(/'$/, ""));
  assert.deepEqual(listed, [...world.writers.UNLISTED_RESPONSES]);
  assert.deepEqual([JSON.stringify(""), JSON.stringify(null)], [...world.writers.UNLISTED_RESPONSES], "how recordAttempt stores a blank answer");
});

const mark = (attemptId: string, over: Record<string, unknown>) => ({
  attemptId, gradeId: "a9a9a9a9-0000-4000-8000-0000000000a9", by: "staff@example.test", passingScore: 70,
  answers: [{ questionId: Q1, responseJson: '"a"' }, { questionId: Q2, responseJson: '"Lift"' }, { questionId: Q3, responseJson: '"Drag"' }],
  ...over,
});
const scored = (score: number, decides: readonly boolean[]) => ({
  score, answers: [Q1, Q2, Q3].slice(0, decides.length).map((questionId, i) => ({ questionId: questionId.toUpperCase(), decidesPass: decides[i]! })),
});

test("only an exam's attempts are recorded: a practice quiz's attempt and its marks write nothing", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const practice = world.attempt(LEARNER_A, SUBMITTED, PRACTICE_QUIZ);
  const exam = world.attempt(LEARNER_A, SUBMITTED, QUIZ);
  const attempt = (attemptId: string) => world.writers.recordExamAttempt(TENANT_A, { attemptId, score: 0, passingScore: 70, passed: false }, submitted(0, 0).grade, ["b"]);
  const decide = (attemptId: string) =>
    world.writers.recordExamMark(TENANT_A, mark(attemptId, { before: scored(100, [true, false, false]), after: scored(50, [true, true, true]) }));
  const flip = (attemptId: string) =>
    world.writers.recordExamMark(TENANT_A, mark(attemptId, { before: scored(100, [true, true, true]), after: scored(50, [true, true, true]) }));

  for (const write of [attempt, decide, flip]) assert.equal(await write(practice), false);
  assert.equal(world.db.records.length, 0, "a practice quiz writes no record");
  assert.ok(world.db.statements.length > 0, "control: the writers did read the attempt");
  assert.deepEqual(world.lines, [], "and logged no failure");

  for (const write of [attempt, decide, flip]) assert.equal(await write(exam), true);
  assert.deepEqual(world.db.records.map((r) => [r.Kind, r.QuizId]), [["exam_fail", QUIZ], ["exam_fail", QUIZ], ["grade_change", QUIZ]]);
});

test("the instructor mark that decides a pending attempt records its pass or fail; a mark that leaves it pending records nothing", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const attemptId = world.attempt(LEARNER_A, SUBMITTED);

  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { before: scored(100, [true, false, false]), after: scored(100, [true, true, false]) })), false);
  assert.deepEqual(world.db.statements, [], "still pending: nothing is read");

  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { before: scored(100, [true, true, false]), after: scored(50, [true, true, true]) })), true);
  const r = record(world);
  assert.deepEqual(
    [r.Kind, r.Result, r.Score, r.PassingScore, r.FailureDetail, r.RecordedBy, r.OccurredAt.toISOString(), r.PayloadJson],
    ["exam_fail", "fail", 50, 70, "scored 50, needed 70", "staff@example.test", SUBMITTED.toISOString(), '{"decidedByGradeId":"a9a9a9a9-0000-4000-8000-0000000000a9"}'],
  );
});

test("a mark that turns a decided pass into a fail, or back, is a grade change; one that keeps the result records nothing", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  const attemptId = world.attempt(LEARNER_A, SUBMITTED);
  const two = { answers: mark(attemptId, {}).answers.slice(0, 2) };

  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { ...two, before: scored(100, [true, true]), after: scored(90, [true, true]) })), false);
  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { ...two, before: scored(40, [true, true]), after: scored(60, [true, true]) })), false);
  assert.deepEqual(world.db.statements, []);

  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { ...two, before: scored(100, [true, true]), after: scored(50, [true, true]) })), true);
  assert.equal(await world.writers.recordExamMark(TENANT_A, mark(attemptId, { ...two, before: scored(50, [true, true]), after: scored(70, [true, true]) })), true);
  assert.deepEqual(
    world.db.records.map((r) => [r.Kind, r.Result, r.Score, r.FailureDetail, JSON.parse(r.PayloadJson)]),
    [
      ["grade_change", "fail", 50, "scored 50, needed 70", { gradeId: "a9a9a9a9-0000-4000-8000-0000000000a9", previousResult: "pass", previousScore: 100 }],
      ["grade_change", "pass", 70, null, { gradeId: "a9a9a9a9-0000-4000-8000-0000000000a9", previousResult: "fail", previousScore: 50 }],
    ],
  );
});

test("a failure to write is logged by ids and its message, and never fails the request", async () => {
  const world = recordsWorld({ tenants: "tenant-a" });
  world.enroll(LEARNER_A, TENANT_A, AT);
  world.db.faults.before = (sql) => (sql.startsWith("SET XACT_ABORT ON") ? new Error("connection reset") : undefined);
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), false);
  assert.equal(world.lines.length, 1);
  assert.match(world.lines[0]!, new RegExp(`^lms-training-records \\| course_completion tenant=${TENANT_A} learner=${LEARNER_A} course=${COURSE}: connection reset \\| ERROR`));
  for (const personal of ["Pilot A", "pilot.a@example.test", COURSE_TITLE]) assert.equal(world.lines[0]!.includes(personal), false, personal);

  world.logging.recordError = async () => { throw new Error("log down"); };
  assert.equal(await world.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), false, "a failed log is swallowed too");

  const lookupFails = recordsWorld({ tenants: "tenant-a" });
  lookupFails.recordsSwitch.trainingRecordsEnabled = async () => { throw new Error("tenant lookup failed"); };
  assert.equal(await lookupFails.writers.recordCourseCompletion(TENANT_A, LEARNER_A, COURSE), false, "a switch that throws is logged");
  assert.equal(lookupFails.lines.length, 1);
  assert.match(lookupFails.lines[0]!, /tenant lookup failed/);
});

test("an instructor's marks on a real attempt write its records through recordInstructorMark, on a chain that verifies", async () => {
  const records = fakeRecordsDb();
  const world = gradingWorld({ records: { tenants: "tenant-a", db: records.module } });
  for (const l of world.db.learners) records.learners.push({ LearnerId: l.learnerId, TenantId: l.tenantId, DisplayName: l.displayName, Email: l.email });
  records.courses.push({ CourseId: COURSE, Title: COURSE_TITLE });
  records.lessons.push({ LessonId: "c2c2c2c2-0000-4000-8000-00000000c2c2", CourseId: COURSE });
  records.blocks.push({ BlockId: BLOCK, LessonId: "c2c2c2c2-0000-4000-8000-00000000c2c2", VersionId: VERSION });
  records.quizzes.push({ QuizId: G_QUIZ, BlockId: BLOCK, IsExam: true });

  const responses = ["a", "Lift comes from the pressure difference."];
  const { attemptId, score } = await world.submit(G_LEARNER, G_QUIZ, responses);
  records.attempts.push({ AttemptId: attemptId, QuizId: G_QUIZ, LearnerId: G_LEARNER, SubmittedAt: SUBMITTED });
  const grade = {
    score, autoGradableCount: 1, correctCount: 1,
    perQuestion: [{ questionId: Q_MCQ, orderIndex: 0, autoGradable: true, correct: true }, { questionId: Q_SHORT, orderIndex: 1, autoGradable: false, correct: null }],
  };
  assert.equal(await world.writers.recordExamAttempt(G_TENANT, { attemptId, score, passingScore: 70, passed: true }, grade, responses), true);

  const override = (points: number) => world.instructor.recordInstructorMark(G_TENANT, "instructor@example.test", {
    action: "override", attemptId, questionId: Q_SHORT, score: points, reason: "Marked against the rubric",
  });
  for (const points of [0, 5, 4]) assert.equal((await override(points)).ok, true);

  assert.deepEqual(records.records.map((r) => [r.Kind, r.Result, r.Score, r.RecordedBy]), [
    ["exam_attempt_pending", "pending", null, "pilot.a@a.test"],
    ["exam_fail", "fail", 50, "instructor@example.test"],
    ["grade_change", "pass", 100, "instructor@example.test"],
  ]);
  assert.ok(records.statements.every((s) => s.params.tenantId === G_TENANT));
  const { rows, head } = await world.trainingRecords.readChain(G_TENANT);
  assert.equal(verifyChain(rows, head).ok, true);
  assert.equal(world.policy.AI_MARKS_DECIDE_PASS, false, "an AI mark never decides, so the AI marking job writes no record; if it may, it needs its own hook");
});

test("nothing about training records reaches an AI model: no AI or model-provider import in the records code", () => {
  const files = ["./chain.ts", "./switch.ts", "./writers.ts", "../db/training-records.ts", "../../scripts/verify-training-records.ts", "../../db/migrations/0034_training_records.sql"];
  let imports = 0;
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    for (const m of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/gm)) {
      imports += 1;
      assert.doesNotMatch(m[2]!, /lib\/ai\b|anthropic|openai|\/claude\b/i, `${file} imports ${m[2]}`);
    }
    assert.doesNotMatch(source, /\bfetch\(|getClaude|messages\.create/, file);
  }
  assert.ok(imports >= 8, "known positive: the imports were read");
});
