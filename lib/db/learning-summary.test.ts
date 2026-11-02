import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as summary from "../learning-summary";
import * as completion from "./completion";
import * as schedule from "./schedule";
import * as scope from "./course-scope";
import { renderSummaryEmail } from "../summary-email";

function load(db: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const source = readFileSync(new URL("./learning-summary.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const modules: Record<string, unknown> = { "@/lib/db": db, "@/lib/learning-summary": summary,
    "@/lib/db/schedule": schedule, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/service-account": { isServiceAccount: () => false }, ...extra };
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const now = new Date("2026-10-18T16:00:00Z");
const learner = { LearnerId: "L", Email: "learner@example.test", DisplayName: "Learner" };
const course = { CourseId: "C", Slug: "course", Title: "Course" };

test("actual collector constrains manager/admin scope in SQL and reports real completion + date-only due today", async () => {
  const statements: string[] = [];
  const db = load({ queryOne: async () => ({ AppUserId: "U", Role: "author" }), query: async (sql: string, params: any) => {
    statements.push(sql);
    assert.equal(params.tenantId, "T");
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) {
      assert.match(sql, /mapping.TenantId = @tenantId/);
      assert.match(sql, /actor.TenantId = @tenantId/);
      assert.match(sql, /actor.Role = 'admin'/);
      assert.equal(params.email, "manager@example.test");
      return [{ ...learner, IsAdmin: false }, { ...learner, LearnerId: "M", Email: "manager@example.test", IsAdmin: false }];
    }
    if (sql.includes("WITH mandatory_for_tenant")) return [];
    if (sql.includes("FROM lms.CourseAssignment a")) return [{ ...course, AssignmentId: "A", LearnerId: "L", AssignedAt: new Date("2026-10-18T10:00:00Z"), DueDate: new Date("2026-10-18T00:00:00Z"), CompletedAt: null }];
    if (sql.includes("FROM lms.Enrollment e")) return [{ ...course, LearnerId: "L", CompletedAt: new Date("2026-10-18T12:00:00Z") }];
    return [course];
  } });
  const result = await db.getLearningSummary("T", "manager@example.test", { now });
  assert.equal(result.team.scope, "manager");
  assert.equal(result.personal.due.length, 0);
  assert.equal(result.team.due.length, 1);
  assert.equal(result.team.overdue.length, 0);
  assert.equal(result.team.completions.length, 1);
  assert.equal(result.team.new_assignments.length, 1);
  for (const sql of statements.filter(sql => sql.includes("JOIN lms.Course c"))) {
    assert.match(sql, /subscription.TenantId = @tenantId/);
    assert.match(sql, /publisher.Slug = @foritSlug/);
    assert.match(sql, /l.TenantId = @tenantId/);
  }
  const assignmentSql = statements.find(sql => sql.includes("FROM lms.CourseAssignment a"))!.replace(/\s+/g, " ");
  assert.ok(assignmentSql.includes(`${completion.lastCompletedAt("e").replace(/\s+/g, " ")} AS CompletedAt`),
    "an assignment met in an earlier cycle stays met while a renewal is open");
});

test("mandatory summary uses subscriber curriculum and subscribed canonical catalog scope for due and overdue", async () => {
  const catalog = { CourseId: "CAT", Slug: "catalog-safety", Title: "Catalog safety" };
  const own = { CourseId: "OWN", Slug: "own-safety", Title: "Own safety" };
  let mandatoryQuery = "";
  const db = load({ query: async (sql: string, params: any) => {
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) return [{ ...learner, IsAdmin: false }];
    if (sql.includes("WITH mandatory_for_tenant")) {
      mandatoryQuery = sql;
      assert.equal(params.now, now);
      assert.equal(params.foritSlug, "forit");
      assert.match(sql, /cu.TenantId = @tenantId/);
      assert.match(sql, /cc.IsMandatory = 1/);
      assert.match(sql, /subscription.TenantId = @tenantId/);
      assert.match(sql, /publisher.Slug = @foritSlug/);
      assert.match(sql, /c.IsCatalog = 1/);
      assert.doesNotMatch(sql, /WHERE c.TenantId = @tenantId/);
      return [{ ...catalog, LearnerId: "L", ScheduleKind: "recurring", RecurrenceMonths: 1, LearnerStart: new Date("2026-09-20"), CertIssuedAt: null },
        { ...own, LearnerId: "L", ScheduleKind: "recurring", RecurrenceMonths: 1, LearnerStart: new Date("2026-09-17"), CertIssuedAt: null }];
    }
    if (sql.includes("FROM lms.CourseAssignment a") || sql.includes("FROM lms.Enrollment e")) return [];
    return [catalog, own];
  } });
  const result = await db.getLearningSummary("T", learner.Email, { now });
  assert.equal(result.personal.due[0].course_id, "CAT");
  assert.equal(result.personal.overdue[0].course_id, "OWN");
  assert.doesNotMatch(mandatoryQuery, /SYSUTCDATETIME/);
  const flatSql = (sql: string) => sql.replace(/\s+/g, " ");
  assert.ok(flatSql(mandatoryQuery).includes(flatSql(scope.entitledToTenant("@now"))),
    "a course entitled at the report instant counts as the buyer's");
  assert.ok(flatSql(mandatoryQuery).includes("JOIN lms.Course c ON c.CourseId = m.CourseId AND (c.TenantId = @tenantId OR"));
  assert.ok(flatSql(mandatoryQuery).includes(flatSql(scope.seatHeldBy("l.LearnerId", "@now"))),
    "and is mandatory for a learner only while they hold its seat");
});

test("mandatory annual and recurring categories use the actual shared deadline with stable first-deadline anchors", async () => {
  const cases: Array<{ name: string; now: string; kind: schedule.ScheduleKind; start: string; issued: string | null; months: number | null; due: string | null; category: "due" | "overdue" | null }> = [
    { name: "new September learner is not overdue before first January", now: "2026-10-18T16:00:00Z", kind: "annual", start: "2026-09-15", issued: null, months: null, due: "2027-01-31", category: null },
    { name: "December starter sees January due within eleven days", now: "2026-01-20T16:00:00Z", kind: "annual", start: "2025-12-15", issued: null, months: null, due: "2026-01-31", category: "due" },
    { name: "missed first January deadline stays overdue", now: "2026-02-15T16:00:00Z", kind: "annual", start: "2025-09-15", issued: null, months: null, due: "2026-01-31", category: "overdue" },
    { name: "January new-hire grace is due tomorrow", now: "2026-02-18T16:00:00Z", kind: "annual", start: "2026-01-20", issued: null, months: null, due: "2026-02-19", category: "due" },
    { name: "January new-hire grace remains due through its day", now: "2026-02-19T23:59:00Z", kind: "annual", start: "2026-01-20", issued: null, months: null, due: "2026-02-19", category: "due" },
    { name: "January new-hire grace becomes overdue next day", now: "2026-02-20T00:01:00Z", kind: "annual", start: "2026-01-20", issued: null, months: null, due: "2026-02-19", category: "overdue" },
    { name: "issued annual certificate is due through January 31", now: "2026-01-31T23:59:00Z", kind: "annual", start: "2024-01-01", issued: "2025-06-01", months: null, due: "2026-01-31", category: "due" },
    { name: "issued annual certificate is overdue February 1", now: "2026-02-01T00:01:00Z", kind: "annual", start: "2024-01-01", issued: "2025-06-01", months: null, due: "2026-01-31", category: "overdue" },
    { name: "recurring first completion is due through its day", now: "2026-10-18T23:59:00Z", kind: "recurring", start: "2026-07-18", issued: null, months: 3, due: "2026-10-18", category: "due" },
    { name: "recurring first completion is overdue next day", now: "2026-10-19T00:01:00Z", kind: "recurring", start: "2026-07-18", issued: null, months: 3, due: "2026-10-18", category: "overdue" },
    { name: "recurring uses latest issue instead of learner start", now: "2026-10-18T16:00:00Z", kind: "recurring", start: "2020-01-01", issued: "2026-09-20", months: 1, due: "2026-10-20", category: "due" },
    { name: "month-end follows shared UTC rollover rather than SQL month clamp", now: "2026-03-01T12:00:00Z", kind: "recurring", start: "2025-01-01", issued: "2026-01-31", months: 1, due: "2026-03-03", category: "due" },
    { name: "never-certified evergreen stays required without fictional deadline", now: "2026-10-18T16:00:00Z", kind: null, start: "2025-01-01", issued: null, months: null, due: null, category: "overdue" },
    { name: "certified evergreen has no new deadline", now: "2026-10-18T16:00:00Z", kind: null, start: "2025-01-01", issued: "2025-02-01", months: null, due: null, category: null },
  ];
  for (const scenario of cases) {
    const current = new Date(scenario.now);
    const start = new Date(scenario.start);
    const issued = scenario.issued ? new Date(scenario.issued) : null;
    const actualHelperDue = schedule.nextDueForLearner(scenario.kind, scenario.months, start, issued, issued ? current : start);
    assert.equal(actualHelperDue?.toISOString().slice(0, 10) ?? null, scenario.due, scenario.name);
    const db = load({ query: async (sql: string) => {
      if (sql.includes("FROM (SELECT @email AS Email) recipient")) return [{ ...learner, IsAdmin: false }];
      if (sql.includes("WITH mandatory_for_tenant")) return [{ ...course, LearnerId: learner.LearnerId,
        ScheduleKind: scenario.kind, RecurrenceMonths: scenario.months, LearnerStart: start, CertIssuedAt: issued }];
      if (sql.includes("FROM lms.CourseAssignment a") || sql.includes("FROM lms.Enrollment e")) return [];
      return [course];
    } });
    const result = await db.getLearningSummary("T", learner.Email, { now: current });
    const rendered = renderSummaryEmail({ slug: "operator", name: "Operator", logoDataUri: null,
      branding: { name: "Operator", primaryColor: "#234567", secondaryColor: "#345678", accentColor: "#456789" } },
      result, "https://operator.example.test/dashboard/summary");
    assert.equal(result.personal.due.length, scenario.category === "due" ? 1 : 0, scenario.name);
    assert.equal(result.personal.overdue.length, scenario.category === "overdue" ? 1 : 0, scenario.name);
    if (scenario.category) {
      assert.equal(result.personal[scenario.category][0].due_date, actualHelperDue?.toISOString() ?? null, scenario.name);
      assert.ok(rendered.html.includes(scenario.category === "due" ? "Training due soon (1)" : "Overdue training (1)"), scenario.name);
    } else {
      assert.doesNotMatch(rendered.html, /Training due soon|Overdue training/, scenario.name);
    }
  }
});

test("latest non-revoked certificate anchors the one mandatory deadline, excluding old expired certificates", async () => {
  const current = new Date("2026-10-18T12:00:00Z");
  const certificates = [
    { id: "old", issued: new Date("2024-01-02"), revoked: false },
    { id: "current", issued: new Date("2026-01-02"), revoked: false },
    { id: "revoked", issued: new Date("2026-10-10"), revoked: true },
  ];
  const db = load({ query: async (sql: string) => {
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) return [{ ...learner, IsAdmin: false }];
    if (sql.includes("WITH mandatory_for_tenant")) {
      assert.match(sql, /OUTER APPLY \(SELECT TOP 1 certificate.IssuedAt/);
      assert.match(sql, /certificate.TenantId = @tenantId AND certificate.RevokedAt IS NULL/);
      assert.match(sql, /ORDER BY certificate.IssuedAt DESC, certificate.CertificateId DESC/);
      const latest = certificates.filter(certificate => !certificate.revoked).sort((a, b) => b.issued.getTime() - a.issued.getTime() || b.id.localeCompare(a.id))[0]!;
      return [{ ...course, LearnerId: learner.LearnerId, ScheduleKind: "annual", RecurrenceMonths: null,
        LearnerStart: new Date("2020-01-01"), CertIssuedAt: latest.issued }];
    }
    if (sql.includes("FROM lms.CourseAssignment a") || sql.includes("FROM lms.Enrollment e")) return [];
    return [course];
  } });
  const result = await db.getLearningSummary("T", learner.Email, { now: current });
  assert.equal(result.personal.overdue.length, 0);
  assert.equal(result.personal.due.length, 0);
  assert.equal(schedule.nextDueForLearner("annual", null, new Date("2020-01-01"), certificates[1]!.issued, current)?.toISOString(), "2027-01-31T00:00:00.000Z");
});

test("persisted certificate expiry survives a subsequent change to the course recurrence policy", async () => {
  const current = new Date("2026-01-20T12:00:00Z");
  const issued = new Date("2025-06-01");
  let expiry = new Date("2026-01-31");
  const db = load({ query: async (sql: string) => {
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) return [{ ...learner, IsAdmin: false }];
    if (sql.includes("WITH mandatory_for_tenant")) {
      assert.match(sql, /SELECT TOP 1 certificate.IssuedAt, certificate.ExpiresAt/);
      return [{ ...course, LearnerId: learner.LearnerId, ScheduleKind: "recurring", RecurrenceMonths: 12,
        LearnerStart: new Date("2020-01-01"), CertIssuedAt: issued, CertExpiresAt: expiry }];
    }
    if (sql.includes("FROM lms.CourseAssignment a") || sql.includes("FROM lms.Enrollment e")) return [];
    return [course];
  } });
  assert.equal(schedule.nextDueForLearner("recurring", 12, null, issued, current)?.toISOString(), "2026-06-01T00:00:00.000Z");
  for (const scenario of [
    { expiry: "2026-01-19", category: "overdue" },
    { expiry: "2026-01-20", category: "due" },
    { expiry: "2026-01-31", category: "due" },
    { expiry: "2026-02-03", category: "due" },
    { expiry: "2026-02-04", category: null },
  ] as const) {
    expiry = new Date(scenario.expiry);
    const result = await db.getLearningSummary("T", learner.Email, { now: current });
    assert.equal(result.personal.overdue.length, scenario.category === "overdue" ? 1 : 0, scenario.expiry);
    assert.equal(result.personal.due.length, scenario.category === "due" ? 1 : 0, scenario.expiry);
    if (scenario.category) assert.equal(result.personal[scenario.category][0].due_date, expiry.toISOString());
  }
});

test("completed enrollment remains authoritative when a later assignment names a different version", async () => {
  const db = load({ query: async (sql: string) => {
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) return [{ ...learner, IsAdmin: false }];
    if (sql.includes("WITH mandatory_for_tenant")) return [];
    if (sql.includes("FROM lms.CourseAssignment a")) {
      assert.match(sql, /e.LearnerId = a.LearnerId AND e.CourseId = a.CourseId AND e.TenantId = @tenantId/);
      assert.doesNotMatch(sql, /e.VersionId = a.VersionId/);
      // Enrollment V1 is the pin resolveLearnerVersion chooses ahead of assignment V2.
      return [{ ...course, LearnerId: "L", AssignmentId: "A", VersionId: "V2", EnrollmentVersionId: "V1",
        AssignedAt: new Date("2026-10-16"), DueDate: new Date("2026-10-17"), CompletedAt: new Date("2026-10-15") }];
    }
    if (sql.includes("FROM lms.Enrollment e")) return [];
    return [course];
  } });
  const result = await db.getLearningSummary("T", learner.Email, { now });
  assert.equal(result.personal.due.length, 0);
  assert.equal(result.personal.overdue.length, 0);
});

test("scope is resolved after data reads so demotion/revocation cannot revive an earlier authorization", async () => {
  const calls: string[] = [];
  const db = load({ query: async (sql: string) => {
    if (sql.includes("FROM (SELECT @email AS Email) recipient")) { calls.push("authorize"); return [{ LearnerId: null, Email: null, DisplayName: null, IsAdmin: false }]; }
    calls.push("data");
    if (sql.includes("WITH mandatory_for_tenant")) return [{ ...course, LearnerId: "L", ScheduleKind: null, RecurrenceMonths: null, LearnerStart: now, CertIssuedAt: null }];
    if (sql.includes("FROM lms.CourseAssignment a") || sql.includes("FROM lms.Enrollment e")) return [];
    return [course];
  } });
  const result = await db.getSummaryDeliverySnapshot("T", "former-manager@example.test", { now });
  assert.equal(result.eligible, false);
  assert.equal(result.summary.team, null);
  assert.equal(summary.summaryItemCount(result.summary), 0);
  assert.equal(calls.at(-1), "authorize");
});

test("claim SQL relies on atomic unique insert, collisions skip and unrelated errors propagate", async () => {
  let available = true;
  const db = load({ queryOne: async (sql: string, params: any) => {
    assert.match(sql, /INSERT INTO lms.DigestDelivery/);
    assert.match(sql, /ERROR_NUMBER\(\) NOT IN \(2601, 2627\) THROW/);
    assert.equal(params.email, "learner@example.test");
    if (!available) return null;
    available = false;
    return { ClaimId: "claim" };
  } });
  const results = await Promise.all([db.claimSummaryDelivery("T", " Learner@Example.test ", now, now), db.claimSummaryDelivery("T", "learner@example.test", now, now)]);
  assert.equal(results.filter(Boolean).length, 1);
  const broken = load({ queryOne: async () => { throw new Error("SQL unavailable"); } });
  await assert.rejects(broken.claimSummaryDelivery("T", "x", now, now), /SQL unavailable/);
});

test("manager relationship changes validate both identities under tenant and allow explicit revocation", async () => {
  const calls: any[] = [];
  const db = load({ queryOne: async (sql: string, params: any) => { calls.push(params); assert.match(sql, /TenantId = @tenantId AND LOWER\(Email\) = @managerEmail/); assert.match(sql, /TenantId = @tenantId AND LOWER\(Email\) = @learnerEmail/); assert.match(sql, /IF @enabled = 0 DELETE/); assert.match(sql, /LOWER\(administrator.Email\) = @changedBy AND administrator.Role = 'admin'/); return null; } });
  assert.equal(await db.setSummaryManager("T", "Manager@Example.test", "Learner@Example.test", false, "admin"), false);
  assert.equal(calls[0].enabled, false);
  assert.equal(calls[0].managerEmail, "manager@example.test");
});

test("delivery finalize is claim-state guarded and failure never frees a claim for retry", async () => {
  const db = load({ execute: async (sql: string, params: any) => {
    assert.match(sql, /TenantId = @tenantId AND ClaimId = @claimId AND Status = 'claimed'/);
    assert.equal(params.status, "uncertain");
    assert.equal(params.error.length, 2048);
    return 1;
  } });
  await db.finishSummaryDelivery("T", "claim", "uncertain", "x".repeat(3000));
  const missing = load({ execute: async () => 0 });
  await assert.rejects(missing.finishSummaryDelivery("T", "claim", "sent"), /could not be finalized/);
});
