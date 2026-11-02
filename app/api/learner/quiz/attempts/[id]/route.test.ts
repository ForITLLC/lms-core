import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";
import { EMAILS, gradingWorld, LEARNER_A, LEARNER_A2, LEARNER_B, OTHER, Q_S0, Q_S1, QUIZ, RUBRIC, SHORT_QUIZ, TENANT, vmLoad } from "@/lib/fixtures/fake-grading-db";

// A learner reads the marks on their own quiz attempt (slice A5b): statuses,
// marks and feedback only, pass or fail from the deciding score, and nobody
// else's attempt, in their tenant or any other.

type Session = { tenantId?: string; email: string; role?: string } | null;
const ANSWER = "Lower pressure above the wing than below it pushes the wing up.";
const AS_A: Session = { tenantId: TENANT, email: EMAILS[LEARNER_A]!, role: "learner" };

async function load(start: Session = AS_A) {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 5, feedbackMd: "Full marks: you named the pressure difference." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["a", ANSWER]);
  let session: Session = start;
  const getSession = { getSessionUser: async () => session };
  const gate = vmLoad(new URL("../../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": getSession, "@/lib/auth/roles": roles, "@/lib/logging": w.logging,
  });
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/get-session": getSession, "@/lib/auth/staff-gate": gate,
    "@/lib/db/answer-grades": w.grades, "@/lib/db/answer-reviews": w.reviews, "@/lib/ai/grading/learner-marks": w.learnerMarks,
  });
  const get = (id: string) => route.GET(new Request(`https://a.example/api/learner/quiz/attempts/${id}`), { params: Promise.resolve({ id }) }) as Promise<Response>;
  return { w, get, attemptId, as: (next: Session) => { session = next; } };
}

test("signed out is 401 and a session with no tenant is 400, before anything is read", async () => {
  for (const [session, status] of [[null, 401], [{ email: EMAILS[LEARNER_A]! }, 400]] as const) {
    const app = await load(session);
    const before = app.w.db.statements.length;
    const res = await app.get(app.attemptId);
    assert.equal(res.status, status);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(app.w.db.statements.length, before);
  }
});

test("another learner's attempt, in the same tenant or another, and anything that isn't an attempt id, all read as not found", async () => {
  const app = await load();
  assert.equal((await app.get(app.attemptId)).status, 200, "known positive: the learner's own attempt");
  for (const [session, id] of [
    [{ tenantId: TENANT, email: EMAILS[LEARNER_A2]!, role: "learner" }, app.attemptId],
    [{ tenantId: TENANT, email: EMAILS[LEARNER_A2]!, role: "admin" }, app.attemptId],
    [{ tenantId: OTHER, email: EMAILS[LEARNER_B]!, role: "learner" }, app.attemptId],
    [{ tenantId: OTHER, email: EMAILS[LEARNER_A]!, role: "learner" }, app.attemptId],
    [AS_A, "not-an-id"],
    [AS_A, "e0e0e0e0-0000-4000-8000-000000000999"],
  ] as const) {
    app.as(session);
    const res = await app.get(id);
    assert.equal(res.status, 404, `${session.email} in ${session.tenantId} reading ${id}`);
    assert.deepEqual(await res.json(), { error: "Attempt not found" });
  }
});

test("the learner sees each written answer's status, mark and feedback; never their answer, the rubric, the model or who marked it; pass follows the deciding score", async () => {
  const app = await load();
  const { attemptId } = await app.w.submit(LEARNER_A, SHORT_QUIZ, [ANSWER, "Drag opposes the motion."]);
  const waiting = await (await app.get(attemptId)).json();
  assert.deepEqual(waiting.written.map((w: { status: string; canAskForReview: boolean }) => [w.status, w.canAskForReview]), [["awaiting_instructor", false], ["awaiting_instructor", false]]);

  await app.w.job.processGradingJobs({ maxJobs: 5 });
  const res = await app.get(attemptId.toUpperCase());
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  const feedback = "Full marks: you named the pressure difference.";
  assert.deepEqual(JSON.parse(text), {
    attemptId,
    score: 0,
    provisionalScore: 100,
    passingScore: 70,
    passed: false,
    waiting: true,
    written: [
      { questionId: Q_S0, orderIndex: 0, status: "ai_provisional", score: 5, maxScore: 5, feedbackMd: feedback, review: "none", canAskForReview: true },
      { questionId: Q_S1, orderIndex: 1, status: "ai_provisional", score: 3, maxScore: 3, feedbackMd: feedback, review: "none", canAskForReview: true },
    ],
  }, "the AI's full marks are provisional: a written-only quiz doesn't pass on them");
  for (const secret of [ANSWER, "Drag opposes", RUBRIC, "claude", "sonnet", "GradedBy", "Reason", "PromptVersion"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.ok(app.w.db.grades.some((g) => g.Model && text.includes(g.FeedbackMd)), "known positive: the AI's mark is the one shown");

  const aiS1 = app.w.db.grades.find((g) => g.QuestionId === Q_S1)!.GradeId as string;
  await app.w.instructor.recordInstructorMark(TENANT, "instructor@a.test", { action: "override", attemptId, questionId: Q_S0, score: 4, reason: "Say why the pressure differs" });
  await app.w.instructor.recordInstructorMark(TENANT, "instructor@a.test", { action: "confirm", attemptId, questionId: Q_S1, gradeId: aiS1 });
  const marked = await (await app.get(attemptId)).json();
  assert.deepEqual(
    [marked.score, marked.passed, marked.waiting, marked.written.map((w: { status: string; score: number }) => [w.status, w.score])],
    [90, true, false, [["instructor_marked", 4], ["instructor_confirmed", 3]]],
  );
  assert.equal(JSON.stringify(marked).includes("Say why the pressure differs"), false, "an override's reason is the staff's");
});
