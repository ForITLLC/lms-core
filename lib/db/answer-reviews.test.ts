import { test } from "node:test";
import assert from "node:assert/strict";
import { EMAILS, gradingWorld, LEARNER_A, LEARNER_B, OTHER, Q_S0, Q_S1, Q_SHORT, QUIZ, RUBRIC, SHORT_QUIZ, TENANT, tenantGaps } from "@/lib/fixtures/fake-grading-db";

// What resolves a learner's review request, and the staff marking queue it
// feeds (slice A5b, migration 0033). A request is answered by the next
// instructor's mark on that answer, recorded in the same transaction as the
// mark; the queue holds each written answer with no instructor's mark, or an
// unanswered request, longest waiting first, and only the tenant's own.

const ANSWER = "Lower pressure above the wing than below it pushes the wing up.";
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const INSTRUCTOR = "instructor@a.test";

function world() {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 3, feedbackMd: "Name <b>why</b> the pressure differs." });
  const ask = (attemptId: string, questionId = Q_SHORT, note: string | null = null) =>
    w.reviews.requestAnswerReview(TENANT, EMAILS[LEARNER_A]!, { attemptId, questionId, note });
  const override = (attemptId: string, score: number, questionId = Q_SHORT) =>
    w.instructor.recordInstructorMark(TENANT, INSTRUCTOR, { action: "override", attemptId, questionId, score, reason: "Checked" });
  const marks = async (attemptId: string) =>
    w.learnerMarks.learnerMarks(await w.grades.readOwnAttempt(TENANT, EMAILS[LEARNER_A]!, attemptId), await w.reviews.listReviewRequests(TENANT, attemptId));
  const queue = async (tenantId = TENANT, limit?: number) => plain(await w.grades.listAnswersAwaitingInstructor(tenantId, limit));
  return { w, ask, override, marks, queue };
}

test("the next instructor's mark answers an open request, in the same write as the mark; an AI mark never does, and a later mark leaves it as it was", async () => {
  const { w, ask, override, marks, queue } = world();
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.job.processNextGrading();
  assert.equal((await ask(attemptId, Q_SHORT, "Please look again")).outcome, "requested");
  assert.equal(w.db.reviews[0]!.ResolvedByGradeId, null, "the AI's mark came first and answers nothing");
  assert.deepEqual(plain((await marks(attemptId)).written.map((m: any) => [m.review, m.canAskForReview])), [["open", false]]);

  const first = await override(attemptId, 4);
  assert.ok(first.ok);
  assert.equal(w.db.reviews[0]!.ResolvedByGradeId, first.gradeId);
  const resolving = w.db.statements.filter((s) => s.sql.includes("UPDATE lms.AnswerReviewRequest"));
  assert.equal(resolving.length, 1);
  assert.ok(resolving[0]!.sql.includes("INSERT INTO lms.AnswerGrade ") && resolving[0]!.sql.startsWith("SET XACT_ABORT ON; BEGIN TRANSACTION;"), "the resolution is part of the mark's transaction");
  assert.deepEqual(plain((await marks(attemptId)).written.map((m: any) => [m.review, m.canAskForReview])), [["answered", false]]);

  const second = await override(attemptId, 5);
  assert.ok(second.ok);
  assert.equal(w.db.reviews[0]!.ResolvedByGradeId, first.gradeId, "the request names the mark that answered it");
});

test("a mark that fails to save answers nothing: the request stays open and the batch changes nothing", async () => {
  const { w, ask, override } = world();
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.job.processNextGrading();
  await ask(attemptId);
  const grades = w.db.grades.length;
  w.db.faults.before = (sql) => (sql.includes("UPDATE lms.AnswerReviewRequest") ? new Error("deadlock victim") : undefined);
  await assert.rejects(override(attemptId, 4), /deadlock victim/);
  assert.deepEqual([w.db.grades.length, w.db.reviews[0]!.ResolvedByGradeId], [grades, null]);
});

test("the queue lists unmarked and AI-marked answers, then answers whose learner asked again, longest waiting first, with what the instructor needs to mark them", async () => {
  const { w, ask, override, queue } = world();
  const one = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.job.processNextGrading();
  const two = await w.submit(LEARNER_A, SHORT_QUIZ, ["Lift comes from <script>alert(1)</script>", "Drag opposes motion."]);
  assert.deepEqual(plain(await queue()).total, 3);

  // An instructor marks the first answer: it leaves the queue.
  await override(one.attemptId, 2);
  let q = await queue();
  assert.deepEqual(q.answers.map((a: any) => [a.attemptId, a.questionId]), [[two.attemptId, Q_S0], [two.attemptId, Q_S1]]);

  // The learner asks again about it, later: it comes back, after the others.
  w.db.clock.t += 60_000;
  assert.equal((await ask(one.attemptId, Q_SHORT, "I did say why.")).outcome, "requested");
  q = await queue();
  assert.equal(q.total, 3);
  assert.deepEqual(q.answers.map((a: any) => [a.attemptId, a.questionId]), [[two.attemptId, Q_S0], [two.attemptId, Q_S1], [one.attemptId, Q_SHORT]]);
  const asked = q.answers[2];
  assert.deepEqual(
    [asked.learnerName, asked.courseTitle, asked.lessonTitle, asked.questionNumber, asked.promptMd, asked.rubricMd, asked.maxScore, asked.answer],
    ["Pilot A", "Principles of Flight", "Lift", 2, "Why does a wing produce lift?", RUBRIC, 5, ANSWER],
  );
  assert.deepEqual([asked.aiScore, asked.aiMaxScore, asked.aiFeedbackMd, asked.instructorScore], [3, 5, "Name <b>why</b> the pressure differs.", 2]);
  assert.deepEqual([asked.review.note, asked.review.requestedAt, asked.waitingSince], ["I did say why.", new Date(w.db.clock.t).toISOString(), new Date(w.db.clock.t).toISOString()]);
  assert.equal(q.answers[0].answer, "Lift comes from <script>alert(1)</script>", "the answer is data; the page shows it as text");
  assert.deepEqual([q.answers[0].aiGradeId, q.answers[0].review], [null, null]);

  // The instructor answers it: the queue is down to the second attempt.
  await override(one.attemptId, 4);
  q = await queue();
  assert.deepEqual([q.total, q.answers.map((a: any) => a.attemptId)], [2, [two.attemptId, two.attemptId]]);
  assert.equal(await w.grades.countAnswersAwaitingInstructor(TENANT), 2);

  const top = await queue(TENANT, 1);
  assert.deepEqual([top.total, top.answers.length], [2, 1], "the total counts beyond the page");
});

test("an empty answer stays out of the queue (every written answer sent before the text box was empty)", async () => {
  const { w, queue } = world();
  w.db.settings.length = 0;
  const empty = await w.submit(LEARNER_A, QUIZ, ["a", ""]);
  const missing = await w.submit(LEARNER_A, QUIZ, ["a", null]);
  const real = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  assert.deepEqual(w.db.responses.filter((r) => r.questionId === Q_SHORT).map((r) => r.responseJson), ['""', "null", JSON.stringify(ANSWER)]);
  const q = await queue();
  assert.deepEqual([q.total, q.answers.map((a: any) => a.attemptId)], [1, [real.attemptId]]);
  assert.ok(![empty.attemptId, missing.attemptId].some((id) => q.answers.some((a: any) => a.attemptId === id)));
});

test("each tenant's queue holds only its own learners' answers, and every queue and review statement names the tenant", async () => {
  const { w, ask, queue } = world();
  const ours = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  const theirs = await w.submit(LEARNER_B, QUIZ, ["a", "Their answer"]);
  await w.job.processGradingJobs({ maxJobs: 5 });
  await ask(ours.attemptId, Q_SHORT, "Ours");
  assert.equal((await w.reviews.requestAnswerReview(OTHER, EMAILS[LEARNER_B]!, { attemptId: theirs.attemptId, questionId: Q_SHORT, note: "Theirs" })).outcome, "requested");
  assert.equal((await w.reviews.requestAnswerReview(TENANT, EMAILS[LEARNER_A]!, { attemptId: theirs.attemptId, questionId: Q_SHORT, note: null })).outcome, "not_found");

  const a = await queue(TENANT);
  const b = await queue(OTHER);
  assert.deepEqual([a.total, a.answers.map((x: any) => [x.attemptId, x.answer, x.review.note])], [1, [[ours.attemptId, ANSWER, "Ours"]]]);
  assert.deepEqual([b.total, b.answers.map((x: any) => [x.attemptId, x.answer, x.review.note])], [1, [[theirs.attemptId, "Their answer", "Theirs"]]]);
  assert.deepEqual(plain(await w.reviews.listReviewRequests(TENANT, theirs.attemptId)), []);
  assert.equal((await w.instructor.recordInstructorMark(TENANT, INSTRUCTOR, { action: "override", attemptId: theirs.attemptId, questionId: Q_SHORT, score: 0, reason: "x" })).ok, false);
  assert.equal(b.answers.length, 1, "another tenant's instructor can't answer it");
  assert.ok((await w.instructor.recordInstructorMark(TENANT, INSTRUCTOR, { action: "override", attemptId: ours.attemptId, questionId: Q_SHORT, score: 1, reason: "x" })).ok);

  const statements = [...new Set(w.db.statements.map((s) => s.sql))].filter((s) => /AnswerReviewRequest|COUNT\(\*\) OVER/.test(s));
  assert.ok(statements.length >= 4, `checked ${statements.length} statements`);
  for (const sql of statements) assert.deepEqual(tenantGaps(sql), [], sql.slice(0, 200));
  const listing = statements.find((s) => s.includes("COUNT(*) OVER"))!;
  assert.notDeepEqual(tenantGaps(listing.replace("WHERE l.TenantId = @tenantId AND ", "WHERE ")), [], "known positive: the listing without its tenant filter");
});
