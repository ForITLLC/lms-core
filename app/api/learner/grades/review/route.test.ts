import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import { EMAILS, gradingWorld, LEARNER_A, LEARNER_A2, LEARNER_B, OTHER, Q_MCQ, Q_SHORT, QUIZ, TENANT, vmLoad } from "@/lib/fixtures/fake-grading-db";

// A learner asks an instructor to look again at the mark on one of their own
// written answers (slice A5b): once per answer, only once it has a mark, never
// someone else's, and the request is audited in the same transaction.

type Session = { tenantId?: string; email: string; role?: string } | null;
const ANSWER = "Lower pressure above the wing than below it pushes the wing up.";
const NOTE = "I explained the pressure difference in my second sentence.";
const AS_A: Session = { tenantId: TENANT, email: EMAILS[LEARNER_A]!, role: "learner" };

async function load(start: Session = AS_A, { marked = true } = {}) {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 2, feedbackMd: "Say why the pressure differs." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  if (marked) await w.job.processNextGrading();
  w.lines.length = 0;
  let session: Session = start;
  const getSession = { getSessionUser: async () => session };
  const gate = vmLoad(new URL("../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": getSession, "@/lib/auth/roles": roles, "@/lib/logging": w.logging,
  });
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/get-session": getSession, "@/lib/auth/staff-gate": gate, "@/lib/db/answer-reviews": w.reviews,
    "@/lib/ai/grading/written-answer": w.writtenAnswer, "@/lib/logging": w.logging,
  });
  const post = (body: unknown) => route.POST(new Request("https://a.example/api/learner/grades/review", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  })) as Promise<Response>;
  return { w, post, attemptId, as: (next: Session) => { session = next; } };
}

test("signed out is 401, no tenant is 400, a malformed body is 400, and none of them writes", async () => {
  const app = await load(null);
  assert.equal((await app.post({ attemptId: app.attemptId, questionId: Q_SHORT })).status, 401);
  app.as({ email: EMAILS[LEARNER_A]! });
  assert.equal((await app.post({ attemptId: app.attemptId, questionId: Q_SHORT })).status, 400);
  app.as(AS_A);
  for (const body of [
    "nope",
    {},
    { attemptId: app.attemptId },
    { attemptId: "not-an-id", questionId: Q_SHORT },
    { attemptId: app.attemptId, questionId: Q_SHORT, note: "x".repeat(501) },
    { attemptId: app.attemptId, questionId: Q_SHORT, tenantId: TENANT },
    { attemptId: app.attemptId, questionId: Q_SHORT, learnerEmail: EMAILS[LEARNER_A2] },
  ]) {
    assert.equal((await app.post(body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual([app.w.db.reviews.length, app.w.db.audit.length], [0, 0]);
});

test("another learner's answer, in the same tenant or another, an automatically marked question and an unknown attempt all read as not found, and write nothing", async () => {
  const app = await load();
  for (const [session, body] of [
    [{ tenantId: TENANT, email: EMAILS[LEARNER_A2]!, role: "learner" }, { attemptId: app.attemptId, questionId: Q_SHORT }],
    [{ tenantId: TENANT, email: EMAILS[LEARNER_A2]!, role: "admin" }, { attemptId: app.attemptId, questionId: Q_SHORT }],
    [{ tenantId: OTHER, email: EMAILS[LEARNER_B]!, role: "learner" }, { attemptId: app.attemptId, questionId: Q_SHORT }],
    [{ tenantId: OTHER, email: EMAILS[LEARNER_A]!, role: "learner" }, { attemptId: app.attemptId, questionId: Q_SHORT }],
    [AS_A, { attemptId: app.attemptId, questionId: Q_MCQ }],
    [AS_A, { attemptId: "e0e0e0e0-0000-4000-8000-000000000999", questionId: Q_SHORT }],
  ] as const) {
    app.as(session);
    const res = await app.post(body);
    assert.equal(res.status, 404, `${session.email} in ${session.tenantId}: ${JSON.stringify(body)}`);
    assert.deepEqual(await res.json(), { error: "Answer not found" });
  }
  assert.deepEqual([app.w.db.reviews.length, app.w.db.audit.length], [0, 0]);
  app.as(AS_A);
  assert.equal((await app.post({ attemptId: app.attemptId, questionId: Q_SHORT })).status, 201, "known positive: the learner's own answer");
});

test("an answer with no mark yet can't be sent back: it is already waiting for an instructor", async () => {
  const app = await load(AS_A, { marked: false });
  const res = await app.post({ attemptId: app.attemptId, questionId: Q_SHORT, note: NOTE });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /hasn't been marked yet/);
  assert.deepEqual([app.w.db.reviews.length, app.w.db.audit.length], [0, 0]);
});

test("a request is recorded once, with its note and an audit event of ids only; asking again is 409, before and after an instructor answers it", async () => {
  const app = await load();
  const res = await app.post({ attemptId: app.attemptId.toUpperCase(), questionId: Q_SHORT, note: `  ${NOTE}  ` });
  assert.equal(res.status, 201);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.review, "open");
  const [request] = app.w.db.reviews;
  assert.deepEqual(
    [request!.RequestId, request!.TenantId, request!.AttemptId, request!.QuestionId, request!.RequestedBy, request!.Note, request!.ResolvedByGradeId],
    [body.requestId, TENANT, app.attemptId, Q_SHORT, EMAILS[LEARNER_A], NOTE, null],
  );
  assert.deepEqual(app.w.db.audit.map((a) => [a.TenantId, a.Actor, a.Verb, a.ObjectKind, a.ObjectId]), [
    [TENANT, EMAILS[LEARNER_A], "quiz.grade.review_requested", "quiz_attempt", app.attemptId],
  ]);
  assert.deepEqual(JSON.parse(app.w.db.audit[0]!.MetaJson), { questionId: Q_SHORT, requestId: body.requestId });
  assert.ok(app.w.lines.some((l) => l.includes(`request=${body.requestId}`)), "known positive: the request was logged");
  for (const line of app.w.lines) for (const secret of [NOTE, ANSWER]) assert.equal(line.includes(secret), false, line);

  const again = await app.post({ attemptId: app.attemptId, questionId: Q_SHORT });
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already asked/);

  await app.w.instructor.recordInstructorMark(TENANT, "instructor@a.test", { action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 3, reason: "Partly there" });
  assert.notEqual(app.w.db.reviews[0]!.ResolvedByGradeId, null, "known positive: the instructor's mark answered it");
  const afterAnswer = await app.post({ attemptId: app.attemptId, questionId: Q_SHORT, note: "And again" });
  assert.equal(afterAnswer.status, 409);
  assert.deepEqual([app.w.db.reviews.length, app.w.db.audit.filter((a) => a.Verb === "quiz.grade.review_requested").length], [1, 1]);
});
