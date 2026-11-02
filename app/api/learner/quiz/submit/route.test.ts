import { test } from "node:test";
import assert from "node:assert/strict";
import { vmLoad } from "@/lib/fixtures/fake-grading-db";

// After an attempt is recorded, its written answers are queued for AI marking
// (slice A5a; the queue itself decides whether marking is on), and the worker
// is kicked once the answer has gone only when something was queued. The
// answer to the learner is unchanged.

const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";

function load(queued: number) {
  const calls: unknown[][] = [];
  const records: unknown[][] = [];
  const afters: unknown[] = [];
  const kickGrading = async () => undefined;
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    "next/server": {
      NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) },
      after: (fn: unknown) => { afters.push(fn); },
    },
    "@/lib/get-session": { getSessionUser: async () => ({ tenantId: TENANT, email: "pilot@example.test", name: "Pilot" }) },
    "@/lib/db/progress": { resolveLearner: async () => ({ learnerId: "L-1" }), ensureEnrollment: async () => true },
    "@/lib/db/quizzes": {
      getQuizForGrading: async () => ({ quizId: "Q-1", passingScore: 70, questions: [{ questionId: "q0", orderIndex: 0, question: { kind: "short" } }] }),
      gradeResponses: () => ({ score: 0, correctCount: 0, autoGradableCount: 0, perQuestion: [{ orderIndex: 0, correct: null }] }),
      recordAttempt: async () => ({ attemptId: "A-1", score: 0, passingScore: 70, passed: false }),
    },
    "@/lib/ai/grading/queue": { queueAnswerMarking: async (...args: unknown[]) => { calls.push(args); return queued; } },
    "@/lib/ai/grading/kick": { kickGrading },
    "@/lib/records/writers": { recordExamAttempt: async (...args: unknown[]) => { records.push(args); return true; } },
  });
  const post = () => route.POST(new Request("https://a.example/api/learner/quiz/submit", {
    method: "POST", body: JSON.stringify({ courseId: "C-1", quizId: "Q-1", responses: ["Lift."] }),
  })) as Promise<Response>;
  return { post, calls, records, afters, kickGrading };
}

test("the attempt's answers go to the queue in the session's tenant; the worker is kicked only when something was queued", async () => {
  for (const queued of [0, 1, 2]) {
    const app = load(queued);
    const res = await app.post();
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(await res.json()), ["attemptId", "score", "passingScore", "passed", "correctCount", "autoGradableCount", "perQuestion"]);
    assert.equal(app.calls.length, 1);
    const [tenantId, attemptId, , responses] = app.calls[0]!;
    assert.deepEqual([tenantId, attemptId, JSON.parse(JSON.stringify(responses))], [TENANT, "A-1", ["Lift."]]);
    assert.deepEqual(app.afters, queued > 0 ? [app.kickGrading] : [], `queued ${queued}`);
    assert.equal(app.records.length, 1, "the attempt is recorded once");
    const [recordTenant, attempt, , recordResponses] = app.records[0]!;
    assert.deepEqual(JSON.parse(JSON.stringify([recordTenant, attempt, recordResponses])), [TENANT, { attemptId: "A-1", score: 0, passingScore: 70, passed: false }, ["Lift."]]);
  }
});
