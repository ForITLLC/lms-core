import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as completion from "./completion";
import * as scope from "./course-scope";
import * as deadlock from "./deadlock";
import * as assemble from "../drill/assemble";
import * as drillSchema from "../drill/schema";
import * as quiz from "../schema/quiz";

// Marketplace contract §1 and §6: a live entitlement gives the buyer the publisher's course, every
// learner row stays in the buyer's tenant, and an assignment past the entitled seats is refused.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const source = (file: string) => flat(readFileSync(new URL(file, import.meta.url), "utf8"));

function capture(answer: (sql: string) => unknown = () => undefined) {
  const calls: Call[] = [];
  const writes: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql: flat(sql), params: { ...params } });
    return answer(sql);
  };
  return {
    calls,
    writes,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? [],
      queryOne: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? null,
      execute: async (sql: string, params?: Record<string, unknown>) => {
        writes.push({ sql: flat(sql), params: { ...params } });
        return record(sql, params) ?? 1;
      },
    },
  };
}

const LIVE = "ent.Status = 'active' AND (ent.AccessUntil IS NULL OR ent.AccessUntil >= CAST(SYSUTCDATETIME() AS date))";
const NOT_SHADOWED = "NOT EXISTS (SELECT 1 FROM lms.Course own_course WHERE own_course.TenantId = @tenantId AND own_course.Slug = c.Slug)";
const ENTITLED = `(EXISTS (SELECT 1 FROM lms.Entitlement ent WHERE ent.TenantId = @tenantId AND ent.CourseId = c.CourseId AND ${LIVE}) AND ${NOT_SHADOWED})`;
const SUBSCRIBED = flat(scope.SUBSCRIBED_IN_SCOPE);

const FREE_SEAT =
  "SELECT TOP 1 ent.EntitlementId, ent.VersionId FROM lms.Entitlement ent WITH (UPDLOCK, HOLDLOCK) " +
  `WHERE ent.TenantId = @tenantId AND ent.CourseId = @courseId AND ${LIVE} ` +
  "AND ent.Seats > (SELECT COUNT(*) FROM lms.CourseAssignment held WITH (UPDLOCK, HOLDLOCK) " +
  "WHERE held.TenantId = ent.TenantId AND held.EntitlementId = ent.EntitlementId AND held.Status = 'active') " +
  "ORDER BY ent.CreatedAt ASC, ent.EntitlementId ASC";

const SEAT_INSERT =
  "DECLARE @id UNIQUEIDENTIFIER = NEWID(); INSERT INTO lms.CourseAssignment " +
  "(AssignmentId, TenantId, LearnerId, CourseId, VersionId, AssignedBy, DueDate, Note, EntitlementId) " +
  "SELECT @id, @tenantId, @learnerId, @courseId, seat.VersionId, @assignedBy, @dueDate, @note, seat.EntitlementId " +
  `FROM (${FREE_SEAT}) seat; ` +
  "SELECT CONVERT(varchar(64), a.AssignmentId) AS AssignmentId, CONVERT(varchar(64), a.VersionId) AS VersionId, " +
  "CONVERT(varchar(64), a.EntitlementId) AS EntitlementId FROM lms.CourseAssignment a " +
  "WHERE a.AssignmentId = @id AND a.TenantId = @tenantId;";

const SEAT_MOVE =
  "DECLARE @moved INT; UPDATE a SET EntitlementId = seat.EntitlementId, AssignedBy = @assignedBy, DueDate = @dueDate, " +
  `Note = @note, Status = 'active' FROM lms.CourseAssignment a CROSS APPLY (${FREE_SEAT}) seat ` +
  "WHERE a.AssignmentId = @assignmentId AND a.TenantId = @tenantId; SET @moved = @@ROWCOUNT; " +
  "SELECT CONVERT(varchar(64), a.EntitlementId) AS EntitlementId FROM lms.CourseAssignment a " +
  "WHERE @moved = 1 AND a.AssignmentId = @assignmentId AND a.TenantId = @tenantId;";

const PLAIN_INSERT =
  "DECLARE @id UNIQUEIDENTIFIER = NEWID(); INSERT INTO lms.CourseAssignment (AssignmentId, TenantId, LearnerId, CourseId, VersionId, " +
  "AssignedBy, DueDate, Note) VALUES (@id, @tenantId, @learnerId, @courseId, @versionId, @assignedBy, @dueDate, @note); " +
  "SELECT CONVERT(varchar(64), @id) AS AssignmentId;";

const PLAIN_UPDATE =
  "UPDATE lms.CourseAssignment SET AssignedBy = @assignedBy, DueDate = @dueDate, Note = @note, Status = 'active' " +
  "WHERE AssignmentId = @assignmentId";

const SEAT = (learner = "@learnerId", at = "SYSUTCDATETIME()") =>
  "(EXISTS (SELECT 1 FROM lms.CourseAssignment seat JOIN lms.Entitlement ent " +
  "ON ent.EntitlementId = seat.EntitlementId AND ent.TenantId = seat.TenantId " +
  `WHERE seat.TenantId = @tenantId AND seat.LearnerId = ${learner} AND seat.CourseId = c.CourseId ` +
  `AND seat.Status = 'active' AND ent.CourseId = c.CourseId AND ${LIVE.replace("SYSUTCDATETIME()", at)}) AND ${NOT_SHADOWED})`;
const TENANT_VISIBLE = `(c.TenantId = @tenantId OR ${SUBSCRIBED} OR ${ENTITLED})`;
// A learner opens a published course, or an archived one they are enrolled in; never a draft (bug 2C58C8DF).
const OPENABLE = (learner = "@learnerId") =>
  "(c.Status = 'published' OR (c.Status = 'archived' AND EXISTS (SELECT 1 FROM lms.Enrollment opened " +
  `WHERE opened.TenantId = @tenantId AND opened.LearnerId = ${learner} AND opened.CourseId = c.CourseId)))`;
const LEARNER_ACCESSIBLE = (learner?: string) => `((c.TenantId = @tenantId OR ${SUBSCRIBED} OR ${SEAT(learner)}) AND ${OPENABLE(learner)})`;

// A learner-facing statement reads lms.Entitlement only through the
// learner's own seat row, never on the tenant alone.
function onlyThroughSeat(sql: string, where: string) {
  const reads = sql.match(/lms\.Entitlement\b/g)?.length ?? 0;
  const seated = sql.match(/lms\.CourseAssignment seat JOIN lms\.Entitlement ent ON ent\.EntitlementId = seat\.EntitlementId/g)?.length ?? 0;
  assert.ok(seated > 0, `${where}: no seat check: ${sql.slice(0, 200)}`);
  assert.equal(reads, seated, `${where}: an entitlement read that is not the learner's seat`);
  assert.ok(!sql.includes(ENTITLED), `${where}: the tenant's entitlement alone admits the learner`);
}

const quizModules = { QuizQuestion: { safeParse: () => ({ success: false }) } };
const coursesModule = (db: unknown) => load("./courses.ts", {
  "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/schema/blocks": {}, "@/lib/schema/quiz": quizModules,
  "@/lib/db/quiz-questions": { groupQuizQuestions: () => new Map(), questionsForQuiz: () => [] },
});

test("a live entitlement shows the course to the tenant's operators; a learner needs a live seat of their own", () => {
  assert.equal(flat(scope.ENTITLEMENT_LIVE), LIVE);
  assert.equal(flat(scope.ENTITLED_TO_TENANT), ENTITLED);
  assert.equal(flat(scope.TENANT_VISIBLE_SCOPE), TENANT_VISIBLE);
  assert.equal(flat(scope.seatHeldBy()), SEAT());
  assert.equal(flat(scope.learnerAccessibleScope()), LEARNER_ACCESSIBLE());
  assert.equal(flat(scope.learnerAccessibleScope("l.LearnerId")), LEARNER_ACCESSIBLE("l.LearnerId"));
  assert.ok(!flat(scope.learnerAccessibleScope()).includes(ENTITLED), "the tenant's entitlement alone opens nothing to a learner");
  assert.ok(SUBSCRIBED.endsWith(`AND ${NOT_SHADOWED})`), "the buyer's own course wins a slug for both cross-tenant routes");
});

test("the course pages and the iPhone app open an entitled course only to a learner holding its seat", async () => {
  const list = capture(() => []);
  const courses = coursesModule(list.db);
  await courses.listCoursesForTenant("T-BUYER", { learnerId: "L-1" });
  await courses.getCourseBySlug("T-BUYER", "dg-air", { learnerId: "L-1" });
  await courses.getCourseBySlug("T-BUYER", "dg-air", { learnerId: "L-1" }, "V-LISTED");
  assert.ok(list.calls[0]!.sql.includes(`OR (${SEAT()} AND c.Status = 'published')`), "course list");
  assert.deepEqual(list.calls[0]!.params, { tenantId: "T-BUYER", learnerId: "L-1" });
  for (const call of list.calls.slice(0, 3)) onlyThroughSeat(call.sql, "learner course read");
  assert.ok(list.calls[1]!.sql.includes(flat(scope.learnerAccessibleScope())), "getCourseBySlug");
  assert.deepEqual(list.calls[1]!.params, { tenantId: "T-BUYER", slug: "dg-air", learnerId: "L-1" });
  assert.match(list.calls[1]!.sql, /ORDER BY CASE WHEN c\.TenantId = @tenantId THEN 0 ELSE 1 END$/, "the own course still wins");

  for (const page of ["../../app/learn/[slug]/page.tsx", "../../app/api/mobile/courses/[slug]/route.ts"]) {
    const s = source(page);
    assert.equal(s.match(/getCourseBySlug\([^)]*\{ learnerId: learner\.learnerId \}/g)?.length, 2, page);
    assert.ok(s.indexOf("resolveLearner(") < 0 || s.indexOf("resolveLearner(") < s.indexOf("getCourseBySlug("), page);
  }
});

test("the /learn listing resolves the learner and lists an entitled course only through their seat", async () => {
  const list = capture(() => []);
  const courses = coursesModule(list.db);
  await courses.listCoursesForTenant("T-BUYER", { learnerId: "L-1" });
  await courses.listCoursesForTenant("T-BUYER", { learnerId: null });
  assert.deepEqual(list.calls[0]!.params, { tenantId: "T-BUYER", learnerId: "L-1" });
  assert.deepEqual(list.calls[1]!.params, { tenantId: "T-BUYER", learnerId: null }, "seat.LearnerId = NULL matches no row");
  for (const call of list.calls) onlyThroughSeat(call.sql, "the /learn listing");
  const page = source("../../app/learn/page.tsx");
  assert.match(page, /const learner = await resolveLearner\(\s*tenantId,\s*session\.email,/);
  assert.match(page, /listCoursesForTenant\(tenantId, \{ learnerId: learner\.learnerId \}\)/);
});

test("operator reads see a course the tenant holds a live entitlement to, with no learner in play", async () => {
  const list = capture(() => []);
  const courses = coursesModule(list.db);
  await courses.listCoursesForTenant("T-BUYER", "operator", { includeDrafts: true });
  await courses.getCourseBySlug("T-BUYER", "dg-air", "operator");
  assert.ok(list.calls[0]!.sql.includes(`OR (${ENTITLED} AND c.Status = 'published')`));
  assert.deepEqual(list.calls[0]!.params, { tenantId: "T-BUYER" });
  assert.ok(list.calls[1]!.sql.includes(TENANT_VISIBLE));
  assert.deepEqual(list.calls[1]!.params, { tenantId: "T-BUYER", slug: "dg-air" });
  for (const call of list.calls) assert.doesNotMatch(call.sql, /seat\./);
  for (const [file, call] of [["../api/reads.ts", /listCoursesForTenant\(tenantId, "operator"/], ["../api/reads.ts", /getCourseBySlug\(tenantId, slug, "operator"\)/],
    ["../../app/admin/courses/page.tsx", /listCoursesForTenant\(tenantId, "operator"/], ["../../app/admin/curriculum/page.tsx", /listCoursesForTenant\(tenantId, "operator"/],
    ["./marketplace-catalogue.ts", /getCourseBySlug\(tenantId, raw\.Slug, "operator", raw\.VersionId\)/]] as const) {
    assert.match(source(file), call, file);
  }
});

test("progress, completion state, quiz grading, drill and certificates need the learner's seat", async () => {
  const progressDb = capture(() => []);
  await load("./progress.ts", { "@/lib/db": progressDb.db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope, "@/lib/db/versions": {} })
    .getProgressForLearner("T-BUYER", "L-1");
  onlyThroughSeat(progressDb.calls[0]!.sql, "dashboard progress");

  const state = capture(() => []);
  await load("./course-completion.ts", { "@/lib/db": state.db, "@/lib/db/course-scope": scope,
    "@/lib/db/quiz-questions": { groupQuizQuestions: () => new Map() } }).getCourseCompletionState("T-BUYER", "L-1", "C-PUB");
  onlyThroughSeat(state.calls[0]!.sql, "completion state");
  assert.ok(state.calls[0]!.sql.includes("e.TenantId = @tenantId"), "the enrolment read stays on the buyer's tenant");

  const grading = capture(() => null);
  await load("./quizzes.ts", { "@/lib/db": grading.db, "@/lib/db/course-scope": scope, "node:crypto": crypto, "@/lib/schema/quiz": quizModules })
    .getQuizForGrading("T-BUYER", "L-1", "C-PUB", "Q-1");
  onlyThroughSeat(grading.calls[0]!.sql, "quiz grading");
  assert.deepEqual(grading.calls[0]!.params, { tenantId: "T-BUYER", learnerId: "L-1", courseId: "C-PUB", quizId: "Q-1" });

  const drillDb = capture(() => []);
  const drill = load("./drill.ts", { "@/lib/db": drillDb.db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/schema/quiz": quiz, "@/lib/drill/assemble": assemble, "@/lib/drill/schema": drillSchema, "node:crypto": crypto });
  await drill.loadDuePool("T-BUYER", "L-1", new Date("2027-01-01T00:00:00Z"));
  await drill.loadNewPool("T-BUYER", "L-1");
  await drill.loadQuestions("T-BUYER", "L-1", ["Q-1"]);
  assert.equal(drillDb.calls.length, 3);
  for (const call of drillDb.calls) {
    onlyThroughSeat(call.sql, "drill");
    assert.equal(call.params.learnerId, "L-1");
  }

  const certDb = capture((sql) => (sql.includes("FROM lms.Course c") ? null : undefined));
  const certificates = load("./certificates.ts", { "@/lib/db": certDb.db, "@/lib/db/course-scope": scope, "@/lib/db/schedule": {}, "node:crypto": crypto });
  assert.equal(await certificates.issueCertificate("T-BUYER", "L-1", "Pilot", "C-PUB"), null, "no seat, no certificate");
  onlyThroughSeat(certDb.calls[0]!.sql, "certificate issue");
  assert.equal(certDb.calls[0]!.params.learnerId, "L-1");
  assert.equal(certDb.writes.length, 0);

  for (const file of ["./progress.ts", "./course-completion.ts", "./quizzes.ts", "./drill.ts", "./certificates.ts", "./dashboard.ts",
    "../../app/api/learner/feedback/route.ts", "../../app/api/learner/block-feedback/route.ts"]) {
    assert.doesNotMatch(source(file), /ENTITLED_TO_TENANT|TENANT_VISIBLE_SCOPE|entitledToTenant/, file);
  }
});

test("course feedback resolves the learner first and finds an entitled course only through their seat", () => {
  for (const file of ["../../app/api/learner/feedback/route.ts", "../../app/api/learner/block-feedback/route.ts"]) {
    const s = source(file);
    assert.match(s, /import \{ seatHeldBy \} from "@\/lib\/db\/course-scope";/, file);
    assert.match(s, /CatalogSubscription[^`]*\bOR \$\{seatHeldBy\(\)\}\)/, file);
    assert.match(s, /\{ tenantId, learnerId, slug \}/, file);
    const calls = [...s.matchAll(/resolveCourseIdBySlug\(session\.tenantId, learner\.learnerId, courseSlug\)/g)];
    assert.ok(calls.length > 0, file);
    for (const call of calls) {
      const before = s.slice(0, call.index);
      assert.ok(before.lastIndexOf("resolveLearner(") > before.lastIndexOf("export async function"), `${file}: learner resolved first`);
    }
  }
});

test("the Optional tier hides an entitled course from a learner without a seat", async () => {
  const { db, calls } = capture(() => []);
  const dashboard = load("./dashboard.ts", { "@/lib/db": db, "@/lib/db/course-scope": scope });
  await dashboard.listOptionalForLearner("T-BUYER", "L-1");
  await dashboard.listUpcomingForLearner("T-BUYER", "L-1");
  await dashboard.getDashboardSummary("T-BUYER", "L-1");
  assert.equal(calls.length, 3);
  const [optional] = calls;
  assert.ok(optional!.sql.includes(`WHERE ${LEARNER_ACCESSIBLE()} AND c.Status = 'published'`), optional!.sql);
  assert.equal(optional!.params.learnerId, "L-1");
  for (const call of calls) {
    onlyThroughSeat(call.sql, "dashboard tier");
    assert.equal(call.params.learnerId, "L-1");
  }
});

test("a mandatory curriculum course counts for a learner only while they hold its seat", async () => {
  const { db, calls } = capture(() => []);
  await load("./overdue.ts", { "@/lib/db": db, "@/lib/db/course-scope": scope }).listOverdueForTenant("T-BUYER");
  const sql = calls[0]!.sql;
  assert.ok(sql.includes(`FROM lms.Course c WHERE ${TENANT_VISIBLE} AND`), "the tenant's mandatory set");
  assert.ok(sql.includes(`CROSS JOIN mandatory_for_tenant m JOIN lms.Course c ON c.CourseId = m.CourseId AND ${LEARNER_ACCESSIBLE("l.LearnerId")}`),
    "each learner keeps the pair only with access");
  assert.match(source("./learning-summary.ts"), /JOIN lms\.Course c ON c\.CourseId = m\.CourseId AND \$\{learnerVisibility\("l\.LearnerId"\)\}/);
  assert.match(source("./learning-summary.ts"), /OR \$\{seatHeldBy\(learner, "@now"\)\}\)`;/);
});

test("the learning summary judges an entitlement and a seat at the instant it reports as of", () => {
  assert.equal(flat(scope.entitledToTenant("@now")), ENTITLED.replace("CAST(SYSUTCDATETIME() AS date)", "CAST(@now AS date)"));
  assert.equal(flat(scope.seatHeldBy("l.LearnerId", "@now")), SEAT("l.LearnerId", "@now"));
  assert.doesNotMatch(scope.entitledToTenant("@now") + scope.seatHeldBy("l.LearnerId", "@now"), /SYSUTCDATETIME/);
});

function enrolling(open: boolean, version: string | null = "V-LISTED") {
  const { db, calls, writes } = capture((sql) => (sql.includes("AS Hit") ? (open ? { Hit: 1 } : null) : undefined));
  const steps: string[] = [];
  const progress = load("./progress.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/db/versions": {
      resolveLearnerVersion: async (...args: string[]) => { steps.push(`resolve:${args.join(":")}`); return version; },
      ensureEnrollmentPinned: async (...args: string[]) => { steps.push(`pin:${args.join(":")}`); },
    } });
  return { run: () => progress.ensureEnrollment("T-BUYER", "L-1", "C-PUB"), calls, writes, steps };
}

test("first touch pins the version the course page would, and writes nothing without access", async () => {
  const open = enrolling(true);
  assert.equal(await open.run(), true);
  assert.deepEqual(open.steps, ["resolve:L-1:C-PUB", "pin:T-BUYER:L-1:C-PUB:V-LISTED"], "the assignment's version, not CurrentVersionId");
  assert.equal(open.calls[0]!.sql, `SELECT TOP 1 1 AS Hit FROM lms.Course c WHERE c.CourseId = @courseId AND ${LEARNER_ACCESSIBLE()}`);
  assert.deepEqual(open.calls[0]!.params, { tenantId: "T-BUYER", learnerId: "L-1", courseId: "C-PUB" });
  assert.equal(open.writes.length, 0, "the pin is versions.ts's MERGE, not a CurrentVersionId insert here");

  const shut = enrolling(false);
  assert.equal(await shut.run(), false);
  assert.deepEqual(shut.steps, []);

  await assert.rejects(enrolling(true, null).run(), /no published version/);
  assert.doesNotMatch(source("./progress.ts"), /CurrentVersionId FROM lms\.Course WHERE CourseId = @courseId/);
});

const nextServer = { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } };
const signedIn = { getSessionUser: async () => ({ tenantId: "T-BUYER", email: "pilot@example.test", name: "Pilot" }) };

test("the progress beacon and quiz submit answer 404 for a course the learner holds no seat on, before writing", async () => {
  for (const enrolled of [false, true]) {
    const steps: string[] = [];
    const beacon = load("../../app/api/learner/progress/route.ts", { "next/server": nextServer, "@/lib/get-session": signedIn,
      "@/lib/db/progress": {
        resolveLearner: async () => ({ learnerId: "L-1", displayName: "Pilot" }),
        ensureEnrollment: async (...args: string[]) => { steps.push(`enroll:${args.join(":")}`); return enrolled; },
        courseBlockKind: async () => "text",
        recordBlockProgress: async () => { steps.push("record"); },
        getCourseProgress: async () => ({ completed: false }),
      } });
    const res = await beacon.POST({ json: async () => ({ courseId: "C-PUB", blockId: "B-1" }) });
    assert.equal(res.status, enrolled ? 200 : 404);
    assert.deepEqual(steps, enrolled ? ["enroll:T-BUYER:L-1:C-PUB", "record"] : ["enroll:T-BUYER:L-1:C-PUB"]);
  }

  for (const [quizFound, enrolled, status] of [[false, true, 404], [true, false, 404], [true, true, 200]] as const) {
    const steps: string[] = [];
    const submit = load("../../app/api/learner/quiz/submit/route.ts", { "next/server": nextServer, "@/lib/get-session": signedIn,
      "@/lib/db/progress": {
        resolveLearner: async () => { steps.push("learner"); return { learnerId: "L-1", displayName: "Pilot" }; },
        ensureEnrollment: async () => { steps.push("enroll"); return enrolled; },
      },
      "@/lib/db/quizzes": {
        getQuizForGrading: async (...args: string[]) => { steps.push(`quiz:${args.join(":")}`); return quizFound ? { quizId: "Q-1", passingScore: 80, questions: [] } : null; },
        gradeResponses: () => ({ correctCount: 0, autoGradableCount: 0, perQuestion: [] }),
        recordAttempt: async () => { steps.push("attempt"); return { attemptId: "A", score: 0, passingScore: 80, passed: false }; },
      },
      "@/lib/ai/grading/queue": { queueAnswerMarking: async () => 0 },
      "@/lib/ai/grading/kick": { kickGrading: async () => undefined },
      "@/lib/records/writers": { recordExamAttempt: async () => { steps.push("record"); return false; } } });
    const res = await submit.POST({ json: async () => ({ courseId: "C-PUB", quizId: "Q-1", responses: [] }) });
    assert.equal(res.status, status);
    assert.equal(steps[0], "learner", "the learner is resolved before the quiz is read");
    assert.equal(steps[1], "quiz:T-BUYER:L-1:C-PUB:Q-1");
    assert.equal(steps.includes("attempt"), status === 200);
    assert.equal(steps.includes("record"), status === 200, "a refused submit writes no training record");
  }
});

test("an earned certificate is read without the course scope, so it stays after access ends", async () => {
  const { db, calls } = capture(() => []);
  const certificates = load("./certificates.ts", { "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/db/schedule": {}, "node:crypto": crypto });
  await certificates.listCertificatesForLearner("L-1");
  await certificates.getCertificateBySerial("FI-2027-00000000");
  for (const call of calls) assert.doesNotMatch(call.sql, /lms\.Entitlement|own_course/);
});

function assignments(answers: {
  needsSeat?: boolean | null;
  existing?: Record<string, unknown> | null;
  seated?: Record<string, unknown> | null;
  moved?: Record<string, unknown> | null;
  claimErrors?: Error[];
}) {
  const claim = (row: unknown) => {
    const err = answers.claimErrors?.shift();
    if (err) throw err;
    return row;
  };
  const fake = capture((sql) => {
    if (sql.includes("FROM lms.Learner")) return { LearnerId: "L-1", Email: "pilot@example.test", DisplayName: "Pilot" };
    if (sql.includes("FROM lms.Course c")) return { CourseId: "C-PUB", Title: "DG Air", CurrentVersionId: "V-CURRENT", NeedsSeat: answers.needsSeat ?? false };
    if (sql.includes("AS HoldsSeat")) return answers.existing ?? null;
    if (sql.includes("CROSS APPLY")) return claim(answers.moved ?? null);
    if (sql.includes("INSERT INTO lms.CourseAssignment")) return sql.includes("seat.EntitlementId") ? claim(answers.seated ?? null) : { AssignmentId: "A-NEW" };
    return undefined;
  });
  const mod = load("./assignments.ts", { "@/lib/db": fake.db, "@/lib/db/course-scope": scope, "@/lib/db/deadlock": deadlock });
  const assign = () => mod.upsertCourseAssignment({ tenantId: "T-BUYER", learnerEmail: "pilot@example.test", courseSlug: "dg-air", assignedBy: "ops@buyer.test" });
  const sqlOf = (marker: string) => fake.calls.filter((c) => c.sql.includes(marker));
  return { mod, assign, sqlOf, ...fake };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const ASSIGN_PARAMS = { assignedBy: "ops@buyer.test", dueDate: null, note: null };

test("the course lookup charges a seat only when neither ownership nor a subscription reaches the course", async () => {
  const { assign, sqlOf } = assignments({});
  await assign();
  const [course] = sqlOf("FROM lms.Course c");
  assert.ok(course!.sql.includes(`CAST(CASE WHEN c.TenantId = @tenantId OR ${SUBSCRIBED} THEN 0 ELSE 1 END AS bit) AS NeedsSeat`), course!.sql);
  assert.ok(course!.sql.endsWith(`WHERE c.Slug = @slug AND ${TENANT_VISIBLE}`), "the picker sees what the tenant is entitled to");
});

test("an owned or subscribed course is assigned exactly as before: no seat check and no EntitlementId", async () => {
  const fresh = assignments({ needsSeat: false });
  const created = await fresh.assign();
  assert.equal(created.created, true);
  assert.equal(created.versionId, "V-CURRENT");
  assert.equal(created.entitlementId, null);
  const insert = fresh.sqlOf("INSERT INTO lms.CourseAssignment");
  assert.equal(insert.length, 1);
  assert.equal(insert[0]!.sql, PLAIN_INSERT);
  assert.deepEqual(insert[0]!.params, { tenantId: "T-BUYER", learnerId: "L-1", courseId: "C-PUB", versionId: "V-CURRENT", ...ASSIGN_PARAMS });

  const again = assignments({ needsSeat: false, existing: { AssignmentId: "A-1", VersionId: "V-OLD", EntitlementId: null, HoldsSeat: false } });
  const updated = await again.assign();
  assert.deepEqual(plain(updated), plain({ learnerId: "L-1", learnerEmail: "pilot@example.test", learnerName: "Pilot", courseId: "C-PUB",
    courseTitle: "DG Air", assignmentId: "A-1", versionId: "V-OLD", entitlementId: null, created: false }));
  assert.deepEqual(again.writes.map((w) => w.sql), [PLAIN_UPDATE]);
  for (const call of [...fresh.calls, ...again.calls].filter((c) => !c.sql.includes("FROM lms.Course c") && !c.sql.includes("AS HoldsSeat"))) {
    assert.doesNotMatch(call.sql, /lms\.Entitlement|EntitlementId/);
  }
});

test("an entitlement-only course takes a seat in the guarded insert and pins the entitlement's version", async () => {
  const { assign, sqlOf, writes } = assignments({ needsSeat: true, seated: { AssignmentId: "A-NEW", VersionId: "V-LISTED", EntitlementId: "E-OLDEST" } });
  const result = await assign();
  assert.equal(result.created, true);
  assert.equal(result.versionId, "V-LISTED", "the listing's version, not the publisher's current one");
  assert.equal(result.entitlementId, "E-OLDEST");
  const [insert, ...more] = sqlOf("INSERT INTO lms.CourseAssignment");
  assert.equal(more.length, 0, "one statement claims the seat and writes the row");
  assert.equal(insert!.sql, SEAT_INSERT);
  assert.deepEqual(insert!.params, { tenantId: "T-BUYER", learnerId: "L-1", courseId: "C-PUB", ...ASSIGN_PARAMS });
  assert.equal(writes.length, 0);
});

test("the seat goes to this tenant's oldest live entitlement on the course with a seat free, counted under lock", async () => {
  const { mod } = assignments({});
  assert.equal(flat(mod.FREE_SEAT), FREE_SEAT);
});

test("a seat is counted the same way the §3 intake counts it", async () => {
  const { db, calls } = capture(() => null);
  await load("./entitlements.ts", { "@/lib/db": db, "@/lib/db/marketplace-catalogue": { LISTABLE: "1 = 1" },
    "@/lib/db/course-scope": scope, "@/lib/db/deadlock": deadlock }).findEntitlement("ol_1");
  const intake = calls[0]!.sql.match(/\(SELECT COUNT\(\*\) FROM lms\.CourseAssignment a WHERE [^)]*\)/)![0];
  const claim = flat(assignments({}).mod.FREE_SEAT).match(/\(SELECT COUNT\(\*\) FROM lms\.CourseAssignment held WITH \(UPDLOCK, HOLDLOCK\) WHERE [^)]*\)/)![0];
  assert.equal(claim.replace(" WITH (UPDLOCK, HOLDLOCK)", "").replace(/\bheld\./g, "a.").replace(" held ", " a ").replace(/\bent\./g, "e."), intake);
});

test("with every seat taken the assignment is refused with no_seats and nothing is written", async () => {
  const { assign, writes, mod } = assignments({ needsSeat: true, seated: null });
  await assert.rejects(assign(), (err: any) => {
    assert.ok(err instanceof mod.AssignmentError);
    assert.equal(err.code, "no_seats");
    assert.equal(err.message, "Every seat bought for dg-air is assigned. Unassign a learner or buy more seats.");
    return true;
  });
  assert.equal(writes.length, 0);
});

test("re-assigning a learner who holds a live seat takes no second seat and keeps the pinned version", async () => {
  const { assign, sqlOf, writes } = assignments({ needsSeat: true, existing: { AssignmentId: "A-1", VersionId: "V-1", EntitlementId: "E-1", HoldsSeat: true } });
  const result = await assign();
  assert.equal(result.created, false);
  assert.equal(result.versionId, "V-1");
  assert.equal(result.entitlementId, "E-1");
  assert.deepEqual(writes.map((w) => w.sql), [PLAIN_UPDATE]);
  assert.deepEqual(writes[0]!.params, { assignmentId: "A-1", ...ASSIGN_PARAMS });
  assert.equal(sqlOf("INSERT").length + sqlOf("CROSS APPLY").length, 0);
});

test("a seat is held only through a live entitlement of the learner's own tenant", async () => {
  const { assign, sqlOf } = assignments({ needsSeat: true, seated: { AssignmentId: "A", VersionId: "V", EntitlementId: "E" } });
  await assign();
  const [existing] = sqlOf("AS HoldsSeat");
  assert.ok(existing!.sql.includes(
    `CAST(CASE WHEN EXISTS (SELECT 1 FROM lms.Entitlement ent WHERE ent.EntitlementId = a.EntitlementId AND ent.TenantId = a.TenantId AND ${LIVE}) THEN 1 ELSE 0 END AS bit) AS HoldsSeat`,
  ), existing!.sql);
  assert.ok(existing!.sql.endsWith("FROM lms.CourseAssignment a WHERE a.TenantId = @tenantId AND a.LearnerId = @learnerId AND a.CourseId = @courseId"));
});

test("an assignment with no live seat moves onto a free one in a guarded update and keeps its version", async () => {
  const held = { AssignmentId: "A-1", VersionId: "V-1", EntitlementId: "E-EXPIRED", HoldsSeat: false };
  const moved = assignments({ needsSeat: true, existing: held, moved: { EntitlementId: "E-2" } });
  const result = await moved.assign();
  assert.deepEqual([result.created, result.versionId, result.entitlementId], [false, "V-1", "E-2"]);
  const [move] = moved.sqlOf("CROSS APPLY");
  assert.equal(move!.sql, SEAT_MOVE);
  assert.deepEqual(move!.params, { tenantId: "T-BUYER", courseId: "C-PUB", assignmentId: "A-1", ...ASSIGN_PARAMS });
  assert.equal(moved.writes.length, 0);

  const full = assignments({ needsSeat: true, existing: held, moved: null });
  await assert.rejects(full.assign(), (err: any) => err.code === "no_seats");
});

test("the admin API answers no_seats with 409 and the plain message", async () => {
  const { mod } = assignments({});
  const route = load("../../app/api/admin/assignments/route.ts", {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    zod: { z },
    "@/lib/get-session": { requireSessionUser: async () => ({ role: "admin", tenantId: "T-BUYER", email: "ops@buyer.test" }) },
    "@/lib/db/assignments": {
      AssignmentError: mod.AssignmentError,
      listAssignmentsForCourse: async () => [],
      listAssignmentsForLearner: async () => [],
      upsertCourseAssignment: async () => { throw new mod.AssignmentError("no_seats", "Every seat bought for dg-air is assigned. Unassign a learner or buy more seats."); },
    },
  });
  const res = await route.POST({ json: async () => ({ learnerEmail: "pilot@example.test", courseSlug: "dg-air" }) });
  assert.equal(res.status, 409);
  assert.deepEqual(plain(res.body), { error: "Every seat bought for dg-air is assigned. Unassign a learner or buy more seats.", code: "no_seats" });
});

test("the first open pins the assignment's version, and a later entitlement version leaves existing pins alone", async () => {
  const { db, calls } = capture(() => ({ VersionId: "V-LISTED" }));
  const versions = load("./versions.ts", { "@/lib/db": db });
  assert.equal(await versions.resolveLearnerVersion("L-1", "C-PUB"), "V-LISTED");
  const order = calls[0]!.sql;
  assert.ok(order.indexOf("SELECT 2 AS Priority, a.VersionId FROM lms.CourseAssignment a") < order.indexOf("SELECT 3 AS Priority, c.CurrentVersionId"));
  await versions.ensureEnrollmentPinned("T-BUYER", "L-1", "C-PUB", "V-LISTED");
  assert.match(calls[1]!.sql, /WHEN NOT MATCHED THEN INSERT \(EnrollmentId, TenantId, LearnerId, CourseId, VersionId, Status\) VALUES \(NEWID\(\), @tenantId,/);
  assert.doesNotMatch(calls[1]!.sql, /WHEN MATCHED/);
  for (const sql of [PLAIN_UPDATE, SEAT_MOVE]) assert.doesNotMatch(sql, /VersionId =/, "a re-assign never re-pins");
  assert.match(SEAT_INSERT, /SELECT @id, @tenantId, @learnerId, @courseId, seat\.VersionId,/, "a new assignment reads the entitlement's version when it is made");
});

test("a seat claim that loses a deadlock is retried once; a second loss or another error fails", async () => {
  const victim = () => Object.assign(new Error("Transaction was deadlocked"), { number: 1205 });
  const seated = { AssignmentId: "A-NEW", VersionId: "V-LISTED", EntitlementId: "E-1" };
  const once = assignments({ needsSeat: true, seated, claimErrors: [victim()] });
  assert.equal((await once.assign()).entitlementId, "E-1");
  const inserts = once.sqlOf("INSERT INTO lms.CourseAssignment");
  assert.equal(inserts.length, 2);
  assert.equal(inserts[1]!.sql, SEAT_INSERT);
  assert.deepEqual(inserts[1]!.params, inserts[0]!.params);

  const held = { AssignmentId: "A-1", VersionId: "V-1", EntitlementId: "E-EXPIRED", HoldsSeat: false };
  const move = assignments({ needsSeat: true, existing: held, moved: { EntitlementId: "E-2" }, claimErrors: [victim()] });
  assert.equal((await move.assign()).entitlementId, "E-2");
  assert.equal(move.sqlOf("CROSS APPLY").length, 2);

  const twice = assignments({ needsSeat: true, seated, claimErrors: [victim(), victim()] });
  await assert.rejects(twice.assign(), /deadlocked/);
  assert.equal(twice.sqlOf("INSERT INTO lms.CourseAssignment").length, 2);

  const other = assignments({ needsSeat: true, seated, claimErrors: [Object.assign(new Error("Timeout"), { number: -2 })] });
  await assert.rejects(other.assign(), /Timeout/);
  assert.equal(other.sqlOf("INSERT INTO lms.CourseAssignment").length, 1);
});
