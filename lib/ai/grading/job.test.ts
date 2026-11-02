import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  EMAILS, flat, gradingWorld, LEARNER_A, LEARNER_B, OTHER, Q_MCQ, Q_S0, Q_S1, Q_SHORT, QUIZ, RUBRIC, SHORT_QUIZ, TENANT, tenantGaps,
} from "@/lib/fixtures/fake-grading-db";

// AI marking of written answers end to end (slice A5a): the submit route's
// queueing, the worker, the real marker and the real lms.AnswerGrade writes,
// over an in-memory database that reads each statement's own WHERE clauses.
// Q4: nothing reaches the model unless the platform switch and the tenant's
// own setting are both on. Q3: an AI mark never moves the pass/fail score.

const ANSWER = "Lower pressure above the wing than below it pushes the wing up.";
const WRONG_MCQ = "b";
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("Q4: with the platform switch or the tenant's setting off, nothing is queued and nothing is sent", async () => {
  for (const [label, options] of [
    ["platform off", { platform: "", marking: [TENANT] }],
    ["platform on for another tenant only", { platform: "tenant-b", marking: [TENANT] }],
    ["tenant setting off (no row)", { marking: [] }],
  ] as const) {
    const w = gradingWorld(options);
    const { queued } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
    assert.equal(queued, 0, label);
    assert.equal(w.db.jobs.length, 0, label);
    assert.deepEqual(plain(await w.job.processGradingJobs({ maxJobs: 5 })), [], label);
    assert.equal(w.sent.length, 0, label);
    assert.equal(w.db.grades.length, 0, label);
  }
  const off = gradingWorld({ platform: "" });
  await off.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  assert.deepEqual(off.slugReads, [], "with the platform switch off the tenant isn't even looked up");

  const on = gradingWorld({ marking: [TENANT] });
  const { queued } = await on.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  assert.equal(queued, 1, "known positive: both on queues the written answer");
  assert.equal((await on.job.processNextGrading()).outcome, "marked");
  assert.equal(on.sent.length, 1);
});

test("Q4: turning either switch off stops jobs already queued, before anything is sent", async () => {
  for (const turnOff of ["setting", "platform"] as const) {
    const w = gradingWorld({ marking: [TENANT] });
    await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
    assert.equal(w.db.jobs.length, 1);
    if (turnOff === "setting") await w.aiSettings.setAiSettings(TENANT, { gradeWrittenAnswers: false }, "admin@example.test");
    else w.env.AI_AUTHORING_TENANTS = "";
    const outcome = await w.job.processNextGrading();
    assert.equal(outcome.outcome, "cancelled", turnOff);
    assert.equal(w.sent.length, 0, turnOff);
    assert.equal(w.db.grades.length, 0);
    assert.equal(w.db.jobs[0]!.Status, "cancelled");
    assert.equal(w.db.jobs[0]!.ErrorMessage, w.job.MARKING_OFF);
    assert.equal(w.db.jobs[0]!.LeaseToken, null);
  }
});

test("only written answers with something in them are queued; the empty string the web player sends today queues nothing", async () => {
  const w = gradingWorld();
  for (const responses of [["a", ""], ["a", "   "], ["a", null], ["a", ["x"]], ["a", "x".repeat(w.grader.ANSWER_MAX_CHARS + 1)]]) {
    const { queued } = await w.submit(LEARNER_A, QUIZ, responses);
    assert.equal(queued, 0, JSON.stringify(responses).slice(0, 40));
  }
  assert.deepEqual(w.slugReads, [], "with nothing to mark the switches aren't read");
  const both = await w.submit(LEARNER_A, SHORT_QUIZ, ["One.", "Two."]);
  assert.equal(both.queued, 2);
  assert.equal(await w.queue.queueAnswerMarking(TENANT, both.attemptId, w.db.questions.filter((q) => q.quizId === SHORT_QUIZ).map((q) => ({ questionId: q.questionId, orderIndex: q.orderIndex, question: q.payload })), ["One.", "Two."]), 0, "asking twice queues nothing more");
  assert.equal(w.db.jobs.length, 2);
});

test("a queue that fails never fails the submit: the answers wait for an instructor and the failure is logged without them", async () => {
  const w = gradingWorld();
  w.db.faults.before = (sql) => (sql.startsWith("INSERT INTO lms.AnswerGradingJob") ? new Error("deadlock victim") : undefined);
  const { queued } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  assert.equal(queued, 0);
  assert.ok(w.lines.some((l) => l.includes("deadlock victim")), "known positive: the failure was logged");
  for (const line of w.lines) assert.equal(line.includes(ANSWER), false);
});

test("the worker records the AI's clamped mark, its model, prompt version and usage, and completes the job in the same write", async () => {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 9, feedbackMd: "Names the pressure difference." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  const outcome = await w.job.processNextGrading();
  assert.equal(outcome.outcome, "marked");
  assert.equal(w.db.grades.length, 1);
  const grade = w.db.grades[0]!;
  assert.deepEqual(
    { Source: grade.Source, Score: grade.Score, MaxScore: grade.MaxScore, Seq: grade.Seq, Model: grade.Model, PromptVersion: grade.PromptVersion, GradedBy: grade.GradedBy, TenantId: grade.TenantId },
    { Source: "ai", Score: 5, MaxScore: 5, Seq: 1, Model: "claude-sonnet-4-6", PromptVersion: w.grader.GRADER_PROMPT_VERSION, GradedBy: null, TenantId: TENANT },
  );
  const job = w.db.jobs[0]!;
  assert.equal(job.Status, "completed");
  assert.equal(job.ResultGradeId, outcome.gradeId);
  assert.deepEqual(JSON.parse(job.UsageJson)["claude-sonnet-4-6"], { calls: 1, inputTokens: 1200, outputTokens: 60, cacheWriteTokens: 0, cacheReadTokens: 1000 });
  const appends = w.db.statements.filter((s) => s.sql.includes("INSERT INTO lms.AnswerGrade "));
  assert.equal(appends.length, 1);
  assert.match(appends[0]!.sql, /INSERT INTO lms\.AnswerGrade .* UPDATE a SET Score = @attemptScore .* UPDATE lms\.AnswerGradingJob SET Status = 'completed'/);
  assert.equal(w.storedScore(attemptId), 100, "the AI's 5 of 5 doesn't move the stored score");

  const [params] = w.sent;
  assert.match(params.messages[0].content, new RegExp(ANSWER));
  assert.ok(params.system[0].text.includes(RUBRIC));
  for (const line of w.lines) {
    for (const secret of [ANSWER, RUBRIC, "Names the pressure"]) assert.equal(line.includes(secret), false, line);
  }
  assert.ok(w.lines.some((l) => l.includes("tokens in=")), "known positive: the run was logged");
});

test("Q3: an unconfirmed AI mark never moves pass or fail; a short-answer-only quiz never passes on AI marks", async () => {
  const w = gradingWorld();
  w.model.reply = (params) => ({ score: params.tools[0].input_schema.properties.score.maximum, feedbackMd: "Full marks." });

  const mixed = await w.submit(LEARNER_A, QUIZ, [WRONG_MCQ, ANSWER]);
  const only = await w.submit(LEARNER_A, SHORT_QUIZ, ["Pressure.", "Bernoulli."]);
  assert.equal(mixed.score, 0);
  assert.equal(only.score, 0);
  const outcomes = await w.job.processGradingJobs({ maxJobs: 10 });
  assert.deepEqual(plain(outcomes.map((o: any) => o.outcome)), ["marked", "marked", "marked"]);
  assert.equal(w.db.grades.filter((g) => g.Score === g.MaxScore).length, 3, "known positive: the AI gave full marks");
  assert.equal(w.storedScore(mixed.attemptId), 0, "would be 50 if the AI's mark counted");
  assert.equal(w.storedScore(only.attemptId), 0, "would be 100 if the AI's marks counted");

  const read = await w.grades.readAttempt(TENANT, only.attemptId);
  const scored = w.score.scoreAttempt(read.answers, read.grades);
  assert.equal(scored.provisionalScore, 100);
  assert.equal(scored.score >= read.passingScore, false);

  const ai = (questionId: string) => w.db.grades.find((g) => g.AttemptId === only.attemptId && g.QuestionId === questionId)!.GradeId;
  const first = await w.instructor.recordInstructorMark(TENANT, "instructor@example.test", { action: "confirm", attemptId: only.attemptId, questionId: Q_S0, gradeId: ai(Q_S0) });
  assert.deepEqual(plain(first.attempt), { attemptId: only.attemptId, score: 100, provisionalScore: 100, passingScore: 70, passed: true });
  assert.equal(w.storedScore(only.attemptId), 100, "a confirmed mark decides");
  const second = await w.instructor.recordInstructorMark(TENANT, "instructor@example.test", { action: "override", attemptId: only.attemptId, questionId: Q_S1, score: 0, reason: "Bernoulli alone isn't the answer" });
  assert.equal(second.attempt.score, 50);
  assert.equal(second.attempt.passed, false);
  assert.equal(w.storedScore(only.attemptId), 50);
});

test("an instructor's override needs a reason and an in-range score, wins over the AI's mark, and writes its audit event in the same transaction", async () => {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 5, feedbackMd: "Full marks." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.job.processNextGrading();
  const before = w.db.grades.length;

  for (const [mark, reason] of [
    [{ score: 2, reason: "" }, "no_reason"],
    [{ score: 2, reason: "   " }, "no_reason"],
    [{ score: 6, reason: "Too generous" }, "score_out_of_range"],
    [{ score: -1, reason: "x" }, "score_out_of_range"],
    [{ score: 2.5, reason: "x" }, "score_out_of_range"],
  ] as const) {
    const result = await w.instructor.recordInstructorMark(TENANT, "instructor@example.test", { action: "override", attemptId, questionId: Q_SHORT, ...mark });
    assert.deepEqual(plain(result), { ok: false, reason }, JSON.stringify(mark));
  }
  assert.equal(w.db.grades.length, before);
  assert.equal(w.db.audit.length, 0);
  assert.deepEqual(plain(await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "override", attemptId, questionId: Q_MCQ, score: 1, reason: "x" })), { ok: false, reason: "not_found" }, "an auto-marked question can't be overridden");

  const result = await w.instructor.recordInstructorMark(TENANT, "instructor@example.test", { action: "override", attemptId, questionId: Q_SHORT.toUpperCase(), score: 2, reason: "Misses why the pressure differs", feedbackMd: "  Say why.  " });
  assert.equal(result.ok, true);
  assert.deepEqual(plain(result.attempt), { attemptId, score: 70, provisionalScore: 70, passingScore: 70, passed: true });
  const grade = w.db.grades.at(-1)!;
  assert.deepEqual(
    { Source: grade.Source, Score: grade.Score, Seq: grade.Seq, GradedBy: grade.GradedBy, Reason: grade.Reason, FeedbackMd: grade.FeedbackMd, ConfirmsGradeId: grade.ConfirmsGradeId },
    { Source: "instructor", Score: 2, Seq: 2, GradedBy: "instructor@example.test", Reason: "Misses why the pressure differs", FeedbackMd: "Say why.", ConfirmsGradeId: null },
  );
  assert.equal(w.storedScore(attemptId), 70);
  assert.equal(w.db.audit.length, 1);
  const audit = w.db.audit[0]!;
  assert.deepEqual({ TenantId: audit.TenantId, Actor: audit.Actor, Verb: audit.Verb, ObjectKind: audit.ObjectKind, ObjectId: audit.ObjectId },
    { TenantId: TENANT, Actor: "instructor@example.test", Verb: "quiz.grade.override", ObjectKind: "quiz_attempt", ObjectId: attemptId });
  const meta = JSON.parse(audit.MetaJson);
  assert.deepEqual(meta, { questionId: Q_SHORT, gradeId: result.gradeId, score: 2, maxScore: 5, attemptScore: 70, previousAttemptScore: 100 });
  assert.equal(audit.MetaJson.includes("Misses why"), false, "the reason is on the grade row, not copied into the audit");
  const batch = w.db.statements.find((s) => s.sql.includes("'instructor'"))!.sql;
  assert.match(batch, /^SET XACT_ABORT ON; BEGIN TRANSACTION; .* INSERT INTO lms\.AnswerGrade .* INSERT INTO lms\.AuditEvent .* COMMIT TRANSACTION;/);

  // A later AI mark (a retried job) can't unseat it.
  const read = await w.grades.readAttempt(TENANT, attemptId);
  assert.equal(w.score.standingGrade(read.grades, Q_SHORT).source, "instructor");
});

test("a confirmation copies the AI's mark and names it; only an AI mark of that answer can be confirmed", async () => {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 3, feedbackMd: "Partly." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, [WRONG_MCQ, ANSWER]);
  await w.job.processNextGrading();
  const aiGrade = w.db.grades[0]!.GradeId;
  assert.deepEqual(plain(await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "confirm", attemptId, questionId: Q_SHORT, gradeId: "f0f0f0f0-0000-4000-8000-0000000000f0" })), { ok: false, reason: "not_found" });

  const result = await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "confirm", attemptId, questionId: Q_SHORT, gradeId: aiGrade.toUpperCase() });
  assert.equal(result.ok, true);
  const grade = w.db.grades.at(-1)!;
  assert.deepEqual({ Source: grade.Source, Score: grade.Score, FeedbackMd: grade.FeedbackMd, ConfirmsGradeId: grade.ConfirmsGradeId, Reason: grade.Reason },
    { Source: "instructor", Score: 3, FeedbackMd: "Partly.", ConfirmsGradeId: aiGrade, Reason: null });
  assert.equal(w.storedScore(attemptId), 30, "(0 + 3/5) over two questions");
  assert.equal(w.db.audit.at(-1)!.Verb, "quiz.grade.confirm");
  assert.equal(JSON.parse(w.db.audit.at(-1)!.MetaJson).confirms, aiGrade);
  assert.deepEqual(plain(await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "confirm", attemptId, questionId: Q_SHORT, gradeId: grade.GradeId })), { ok: false, reason: "not_found" }, "an instructor's mark isn't confirmable");
});

test("tenant isolation, semantically: another tenant can't read, queue, mark or have the worker mark an attempt that isn't theirs", async () => {
  const w = gradingWorld();
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  assert.ok(await w.grades.readAttempt(TENANT, attemptId), "known positive: the owner reads it");
  assert.equal(await w.grades.readAttempt(OTHER, attemptId), null);
  assert.equal(await w.grades.enqueueGradingJob(OTHER, attemptId, Q_SHORT), false);
  assert.deepEqual(plain(await w.instructor.recordInstructorMark(OTHER, "admin@b.test", { action: "override", attemptId, questionId: Q_SHORT, score: 0, reason: "x" })), { ok: false, reason: "not_found" });
  assert.equal(w.db.grades.length, 0);
  assert.equal(w.db.audit.length, 0);

  // A forged job naming the other tenant reads nothing and sends nothing.
  w.db.jobs[0]!.TenantId = OTHER;
  const outcome = await w.job.processNextGrading();
  assert.equal(outcome.outcome, "failed");
  assert.equal(w.sent.length, 0);
  assert.equal(w.db.grades.length, 0);

  // An append batch can't reach another tenant's attempt even with a held job.
  w.db.jobs[0]!.TenantId = TENANT;
  const theirs = await w.submit(LEARNER_B, QUIZ, ["a", ANSWER]);
  const job = { jobId: w.db.jobs[0]!.JobId, tenantId: TENANT, attemptId: theirs.attemptId, questionId: Q_SHORT, attempts: 1, usageJson: null, leaseToken: "lt" };
  Object.assign(w.db.jobs[0]!, { Status: "running", LeaseToken: "lt" });
  const appended = await w.grades.appendAiGrade(job, { attemptId: theirs.attemptId, seen: 0, attemptScore: 100 },
    { gradeId: "f1f1f1f1-0000-4000-8000-0000000000f1", questionId: Q_SHORT, score: 5, maxScore: 5, feedbackMd: null, model: "m", promptVersion: "v" }, "{}");
  assert.equal(appended, "not_found");
  assert.equal(w.db.grades.length, 0);

  const awaitingA = await w.grades.listAnswersAwaitingInstructor(TENANT);
  const awaitingB = await w.grades.listAnswersAwaitingInstructor(OTHER);
  assert.deepEqual(plain(awaitingA.answers.map((a: any) => a.attemptId)), [attemptId]);
  assert.deepEqual(plain(awaitingB.answers.map((a: any) => a.attemptId)), [theirs.attemptId]);
});

test("tenant isolation, textually: every statement but the claim filters on the tenant, and the checker catches each filter taken out", async () => {
  const w = gradingWorld();
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.job.processNextGrading();
  await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "override", attemptId, questionId: Q_SHORT, score: 1, reason: "x" });
  assert.equal((await w.reviews.requestAnswerReview(TENANT, EMAILS[LEARNER_A], { attemptId, questionId: Q_SHORT, note: "Look again" })).outcome, "requested");
  await w.reviews.listReviewRequests(TENANT, attemptId);
  assert.ok(await w.grades.readOwnAttempt(TENANT, EMAILS[LEARNER_A], attemptId));
  await w.grades.listAnswersAwaitingInstructor(TENANT);
  await w.aiSettings.setAiSettings(TENANT, { gradeWrittenAnswers: true }, "admin@example.test");
  await w.aiSettings.getAiSettings(TENANT);
  const held = { jobId: "x", tenantId: TENANT, attemptId, questionId: Q_SHORT, attempts: 1, usageJson: null, leaseToken: "x" };
  await w.grades.completeGradingJob(held, null, "{}");
  await w.grades.endGradingJob(held, "failed", "x", "{}");
  await w.grades.requeueGradingJob(held, 60, "x", "{}");

  const statements = [...new Set(w.db.statements.map((s) => s.sql))];
  const kinds = ["FROM lms.QuizAttempt a JOIN lms.Learner l", "FROM lms.AnswerGrade WHERE", "INSERT INTO lms.AnswerGradingJob", "WITH next AS",
    "'ai', @score", "'instructor', @score", "SET Status = 'completed'", "SET Status = @status", "SET Status = 'queued'", "OUTER APPLY", "lms.TenantAiSetting WHERE", "INSERT INTO lms.TenantAiSetting",
    "INSERT INTO lms.AnswerReviewRequest", "UPDATE lms.AnswerReviewRequest", "FROM lms.AnswerReviewRequest WHERE", "OUTER APPLY (SELECT TOP (1) x.Note", "l.Email = @learnerEmail"];
  for (const kind of kinds) assert.ok(statements.some((s) => s.includes(kind)), `exercised: ${kind}`);

  let cuts = 0;
  const claims = statements.filter((s) => s.includes("READPAST"));
  assert.equal(claims.length, 1, "the claim is the one statement that spans tenants");
  for (const sql of statements.filter((s) => !s.includes("READPAST"))) {
    assert.deepEqual(tenantGaps(sql), [], sql.slice(0, 160));
    // Known positives: take out each tenant filter in turn and the checker sees it.
    const filters = [...sql.matchAll(/(?:\b\w+\.)?TenantId = @tenantId/g)];
    for (const filter of filters) {
      const at = filter.index!;
      const before = sql.slice(0, at);
      const after = sql.slice(at + filter[0].length);
      const cut = before.endsWith(" AND ") ? before.slice(0, -5) + after
        : after.startsWith(" AND ") ? before + after.slice(5)
          : before.replace(/ WHERE $/, " ") + after;
      assert.notDeepEqual(tenantGaps(cut), [], `taking out "${filter[0]}" at ${at} goes unseen: ${cut.slice(0, 200)}`);
      cuts++;
    }
  }
  assert.equal(cuts >= 20, true, `the sweep took out ${cuts} filters`);
  assert.ok(statements.filter((s) => !s.includes("READPAST")).every((s) => !/lms\.(AnswerGrade|AnswerGradingJob|AnswerReviewRequest|TenantAiSetting|QuizAttempt)\b/.test(s) || /@tenantId/.test(s)));
  assert.ok(tenantGaps(flat("SELECT 1 FROM lms.AnswerGrade WHERE AttemptId = @attemptId")).length > 0, "known positive: an unfiltered read");
});

test("a mark that lands while the AI's is being saved isn't overwritten: the worker reads again and the stored score agrees with every mark", async () => {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 5, feedbackMd: "Full." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, [WRONG_MCQ, ANSWER]);
  let raced = false;
  w.db.faults.before = (sql) => {
    if (!raced && sql.includes("'ai', @score")) {
      raced = true;
      w.db.grades.push({ GradeId: "f2f2f2f2-0000-4000-8000-0000000000f2", TenantId: TENANT, AttemptId: attemptId, QuestionId: Q_SHORT, Seq: 1, Source: "instructor", Score: 1, MaxScore: 5, FeedbackMd: null, Model: null, PromptVersion: null, GradedBy: "i@example.test", Reason: "Thin", ConfirmsGradeId: null, GradedAt: w.db.clock.t });
      w.db.attempts.find((a) => a.attemptId === attemptId)!.score = 10;
    }
    return undefined;
  };
  const outcome = await w.job.processNextGrading();
  assert.equal(outcome.outcome, "marked");
  assert.equal(raced, true);
  assert.deepEqual(w.db.grades.map((g) => [g.Seq, g.Source]), [[1, "instructor"], [2, "ai"]]);
  assert.equal(w.storedScore(attemptId), 10, "the instructor's 1 of 5 still decides");
  assert.equal(w.sent.length, 1, "the answer was sent once");
});

test("an answer an instructor already marked is skipped without sending; a lost lease writes nothing", async () => {
  const w = gradingWorld();
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  await w.instructor.recordInstructorMark(TENANT, "i@example.test", { action: "override", attemptId, questionId: Q_SHORT, score: 4, reason: "Marked by hand" });
  assert.equal((await w.job.processNextGrading()).outcome, "skipped");
  assert.equal(w.sent.length, 0);
  assert.equal(w.db.jobs[0]!.Status, "completed");

  const lost = gradingWorld();
  await lost.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  lost.db.faults.before = (sql) => {
    if (sql.includes("'ai', @score")) lost.db.jobs[0]!.LeaseToken = "someone-else";
    return undefined;
  };
  assert.equal((await lost.job.processNextGrading()).outcome, "lease_lost");
  assert.equal(lost.db.grades.length, 0);
  assert.equal(lost.db.jobs[0]!.Status, "running");
});

test("a rate limit requeues with backoff; a mark that doesn't fit the tool fails with its tokens kept; the answer then waits for an instructor", async () => {
  const w = gradingWorld();
  w.model.reply = () => new Anthropic.RateLimitError(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, undefined, {});
  await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  const first = await w.job.processNextGrading();
  assert.deepEqual(plain(first), { outcome: "requeued", jobId: w.db.jobs[0]!.JobId, delaySeconds: 60 });
  assert.equal(w.db.jobs[0]!.Status, "queued");
  assert.equal((await w.job.processNextGrading()).outcome, "idle", "not due yet");

  w.db.clock.t += 61_000;
  w.model.reply = () => ({ score: "five", feedbackMd: "x" });
  const second = await w.job.processNextGrading();
  assert.equal(second.outcome, "failed");
  assert.equal(w.db.jobs[0]!.Status, "failed");
  assert.equal(JSON.parse(w.db.jobs[0]!.UsageJson)["claude-sonnet-4-6"].calls, 1);
  assert.equal(w.db.grades.length, 0);
  const awaiting = await w.grades.listAnswersAwaitingInstructor(TENANT);
  assert.equal(awaiting.total, 1);
  assert.equal(awaiting.answers[0].aiGradeId, null);
});

test("the worker stops at maxJobs, and when the queue is empty", async () => {
  const w = gradingWorld();
  for (let i = 0; i < 3; i++) await w.submit(LEARNER_A, SHORT_QUIZ, ["One.", "Two."]);
  assert.equal(w.db.jobs.length, 6);
  assert.equal((await w.job.processGradingJobs({ maxJobs: 4 })).length, 4);
  assert.equal((await w.job.processGradingJobs({ maxJobs: 4 })).length, 2);
  assert.deepEqual(plain(await w.job.processGradingJobs({ maxJobs: 4 })), []);
  assert.equal(w.sent.length, 6);
  assert.ok(w.db.grades.every((g) => g.QuestionId === Q_S0 ? g.MaxScore === 5 : g.QuestionId === Q_S1 && g.MaxScore === 3));
});
