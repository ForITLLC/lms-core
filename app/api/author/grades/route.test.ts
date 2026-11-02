import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import * as permissions from "@/lib/auth/records-permissions";
import * as roles from "@/lib/auth/roles";
import { gradingWorld, LEARNER_A, OTHER, Q_SHORT, QUIZ, TENANT, vmLoad } from "@/lib/fixtures/fake-grading-db";

// An instructor marks a written answer (slice A5a; the marking queue page is
// A5b): a role of the attempt's own tenant that may mark exams (canMarkExams:
// staff, and since card d3e16430 an instructor or a training manager); an
// override says why; the new mark wins over the AI's, moves the attempt's
// pass/fail score and writes its audit event in the same transaction.

type Session = { tenantId?: string; email: string; role?: string } | null;
const AUTHOR = { tenantId: TENANT, email: "instructor@a.test", role: "author" };
const ANSWER = "Lower pressure above the wing.";

async function load(start: Session = AUTHOR) {
  const w = gradingWorld();
  w.model.reply = () => ({ score: 5, feedbackMd: "Full marks." });
  const { attemptId } = await w.submit(LEARNER_A, QUIZ, ["b", ANSWER]);
  await w.job.processNextGrading();
  const aiGradeId = w.db.grades[0]!.GradeId as string;
  w.lines.length = 0;
  let session: Session = start;
  const gate = vmLoad(new URL("../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": w.logging,
  });
  const route = vmLoad(new URL("./route.ts", import.meta.url), {
    zod: { z }, "@/lib/auth/staff-gate": gate, "@/lib/auth/records-permissions": permissions, "@/lib/ai/grading/instructor": w.instructor, "@/lib/logging": w.logging,
  });
  const post = (body: unknown) => route.POST(new Request("https://a.example/api/author/grades", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body),
  })) as Promise<Response>;
  return { w, post, attemptId, aiGradeId, as: (next: Session) => { session = next; } };
}

test("signed out is 401, a learner is 403, and nothing is written", async () => {
  for (const [session, status] of [[null, 401], [{ tenantId: TENANT, email: "l@a.test", role: "learner" }, 403], [{ tenantId: TENANT, email: "l@a.test" }, 403]] as const) {
    const app = await load(session);
    const res = await app.post({ action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 0, reason: "x" });
    assert.equal(res.status, status);
    assert.equal(app.w.db.grades.length, 1, "only the AI's mark");
    assert.equal(app.w.db.audit.length, 0);
  }
});

test("staff of another tenant get 404 for the attempt, whether overriding or confirming, and write nothing", async () => {
  const app = await load({ tenantId: OTHER, email: "admin@b.test", role: "admin" });
  for (const body of [
    { action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 0, reason: "Not theirs" },
    { action: "confirm", attemptId: app.attemptId, questionId: Q_SHORT, gradeId: app.aiGradeId },
  ]) {
    const res = await app.post(body);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Answer not found" });
  }
  assert.equal(app.w.db.grades.length, 1);
  assert.equal(app.w.db.audit.length, 0);
});

test("an override with no reason is 400; a malformed body is 400; neither writes", async () => {
  const app = await load();
  for (const reason of [undefined, "", "   "]) {
    const res = await app.post({ action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 1, ...(reason === undefined ? {} : { reason }) });
    assert.equal(res.status, 400, JSON.stringify(reason));
    assert.match((await res.json()).error, /reason/);
  }
  for (const body of [
    "nope",
    { action: "delete", attemptId: app.attemptId, questionId: Q_SHORT },
    { action: "override", attemptId: "not-a-uuid", questionId: Q_SHORT, score: 1, reason: "x" },
    { action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 1.5, reason: "x" },
    { action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 1, reason: "x", tenantId: TENANT },
    { action: "confirm", attemptId: app.attemptId, questionId: Q_SHORT },
  ]) {
    assert.equal((await app.post(body)).status, 400, JSON.stringify(body));
  }
  const tooHigh = await app.post({ action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 6, reason: "x" });
  assert.equal(tooHigh.status, 400);
  assert.equal(app.w.db.grades.length, 1);
  assert.equal(app.w.db.audit.length, 0);
});

test("an override supersedes the AI's mark, moves the pass/fail score and writes the audit event; the log carries ids only", async () => {
  const app = await load();
  assert.equal(app.w.storedScore(app.attemptId), 0, "the AI's 5 of 5 didn't count");
  const res = await app.post({ action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 4, reason: "Good, but say why the pressure differs", feedbackMd: "Say why." });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.deepEqual(body.attempt, { attemptId: app.attemptId, score: 40, provisionalScore: 40, passingScore: 70, passed: false });
  assert.equal(app.w.storedScore(app.attemptId), 40);
  const grade = app.w.db.grades.at(-1)!;
  assert.deepEqual([grade.GradeId, grade.Source, grade.Score, grade.GradedBy, grade.Reason], [body.gradeId, "instructor", 4, "instructor@a.test", "Good, but say why the pressure differs"]);
  assert.deepEqual(app.w.db.audit.map((a) => [a.TenantId, a.Actor, a.Verb, a.ObjectId]), [[TENANT, "instructor@a.test", "quiz.grade.override", app.attemptId]]);
  assert.ok(app.w.lines.some((l) => l.includes(`grade=${body.gradeId}`)), "known positive: the mark was logged");
  for (const line of app.w.lines) for (const secret of [ANSWER, "say why the pressure", "Say why."]) assert.equal(line.includes(secret), false, line);
});

test("a confirmation copies the AI's mark and makes it count", async () => {
  const app = await load({ tenantId: TENANT, email: "admin@a.test", role: "admin" });
  const res = await app.post({ action: "confirm", attemptId: app.attemptId, questionId: Q_SHORT, gradeId: app.aiGradeId });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.attempt, { attemptId: app.attemptId, score: 50, provisionalScore: 50, passingScore: 70, passed: false });
  assert.equal(app.w.db.grades.at(-1)!.ConfirmsGradeId, app.aiGradeId);
  assert.equal(app.w.db.audit.at(-1)!.Verb, "quiz.grade.confirm");
});

test("an instructor or a training manager of the tenant marks an answer, recorded as who marked it", async () => {
  for (const role of ["instructor", "training_manager"]) {
    const app = await load({ tenantId: TENANT, email: `${role}@a.test`, role });
    const res = await app.post({ action: "override", attemptId: app.attemptId, questionId: Q_SHORT, score: 3, reason: "Half the answer" });
    assert.equal(res.status, 200, role);
    const grade = app.w.db.grades.at(-1)!;
    assert.deepEqual([grade.Source, grade.Score, grade.GradedBy], ["instructor", 3, `${role}@a.test`], role);
    assert.deepEqual(app.w.db.audit.map((a) => [a.Actor, a.Verb]), [[`${role}@a.test`, "quiz.grade.override"]], role);
  }
  const elsewhere = await load({ tenantId: OTHER, email: "instructor@b.test", role: "instructor" });
  const res = await elsewhere.post({ action: "override", attemptId: elsewhere.attemptId, questionId: Q_SHORT, score: 0, reason: "Not theirs" });
  assert.equal(res.status, 404, "another tenant's instructor doesn't find the answer");
  assert.equal(elsewhere.w.db.audit.length, 0);
});

// Marking is the only author API an instructor or a training manager reaches:
// every other handler under app/api/author keeps the staff check.
test("every other app/api/author handler asks requireTenantStaff, and none asks canMarkExams", () => {
  const root = new URL("../", import.meta.url);
  const routes: string[] = [];
  const walk = (dir: URL, rel: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir), `${rel}${entry.name}/`);
      else if (entry.name === "route.ts") routes.push(`${rel}${entry.name}`);
    }
  };
  walk(root, "");
  assert.ok(routes.includes("grades/route.ts") && routes.includes("courses/route.ts"), routes.join(", "));
  const others = routes.filter((r) => r !== "grades/route.ts");
  assert.ok(others.length >= 6, others.join(", "));
  for (const route of others) {
    const source = readFileSync(new URL(route, root), "utf8");
    const handlers = source.match(/export async function (GET|POST|PUT|PATCH|DELETE)\(/g) ?? [];
    assert.ok(handlers.length > 0, route);
    assert.equal((source.match(/await requireTenantStaff\(\)/g) ?? []).length, handlers.length, route);
    assert.doesNotMatch(source, /canMarkExams|records-permissions|requireTenantRole/, route);
  }
  const grades = readFileSync(new URL("grades/route.ts", root), "utf8");
  assert.match(grades, /await requireTenantRole\(canMarkExams\)/, "known positive");
  assert.doesNotMatch(grades, /requireTenantStaff\(\)/);
});
