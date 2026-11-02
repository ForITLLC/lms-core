import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as scope from "./course-scope";
import * as deadlock from "./deadlock";

// The order line is the only global read. Seats are counted from the buyer's live assignments,
// the slug clash reads the courses the buyer reaches, and the course check reads under its publisher.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

function fakeDb(answer: (sql: string, params: Record<string, unknown>) => unknown = () => undefined) {
  const calls: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params: { ...params } });
    return answer(sql, params);
  };
  return {
    calls,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? [],
      queryOne: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? null,
      execute: async (sql: string, params?: Record<string, unknown>) => {
        const result = record(sql, params);
        if (result instanceof Error) throw result;
        return result ?? 1;
      },
    },
  };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

const LISTABLE = load("marketplace-catalogue.ts", {
  "@/lib/db": fakeDb().db,
  "@/lib/db/courses": { parseTags: () => [], getCourseBySlug: async () => null },
}).LISTABLE as string;

function entitlements(answer?: (sql: string, params: Record<string, unknown>) => unknown) {
  const { db, calls } = fakeDb(answer);
  const mod = load("entitlements.ts", { "@/lib/db": db, "@/lib/db/marketplace-catalogue": { LISTABLE },
    "@/lib/db/course-scope": scope, "@/lib/db/deadlock": deadlock });
  return { mod, calls };
}

const LIVE_COUNT =
  "(SELECT COUNT(*) FROM lms.CourseAssignment a WHERE a.TenantId = e.TenantId AND a.EntitlementId = e.EntitlementId AND a.Status = 'active')";
const LOCKED_LIVE_COUNT =
  "(SELECT COUNT(*) FROM lms.CourseAssignment a WITH (HOLDLOCK) WHERE a.TenantId = e.TenantId AND a.EntitlementId = e.EntitlementId AND a.Status = 'active')";

test("an entitlement is read by its order line, with the buyer's slug and its live seat count", async () => {
  const row = { EntitlementId: "E-1", OrderLineId: "ol_1", TenantId: "T-CHARTER", TenantSlug: "charter", CourseId: "C-1", VersionId: "V-1",
    Seats: 25, SeatsAssigned: 9, AccessUntil: "2027-11-30", Status: "active" };
  const { mod, calls } = entitlements(() => row);
  assert.deepEqual({ ...(await mod.findEntitlement("ol_1")) }, row);
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /FROM lms\.Entitlement e JOIN lms\.Tenant t ON t\.TenantId = e\.TenantId WHERE e\.OrderLineId = @orderLineId$/);
  assert.ok(sql.includes(`e.Seats, ${LIVE_COUNT} AS SeatsAssigned`), sql);
  assert.match(sql, /CONVERT\(char\(10\), e\.AccessUntil, 23\) AS AccessUntil/, "a DATE leaves as YYYY-MM-DD, never a JS Date");
  assert.match(sql, /t\.Slug AS TenantSlug/);
  assert.deepEqual(calls[0]!.params, { orderLineId: "ol_1" });
});

test("unassigning still deletes the row and no other assignment status is written", () => {
  const assignments = readFileSync(new URL("./assignments.ts", import.meta.url), "utf8");
  assert.match(assignments, /DELETE FROM lms\.CourseAssignment/);
  assert.doesNotMatch(assignments, /Status\s*=\s*'(?!active')/, "a new assignment status exists; decide whether it holds a seat");
});

test("any active tenant can be the buyer", async () => {
  const { mod, calls } = entitlements(() => ({ TenantId: "T-CHARTER", Slug: "charter" }));
  assert.deepEqual({ ...(await mod.resolveBuyerTenant("charter")) }, { TenantId: "T-CHARTER", Slug: "charter" });
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /FROM lms\.Tenant t WHERE t\.Slug = @slug AND t\.IsActive = 1$/);
  assert.doesNotMatch(sql, /IsPublisher/);
  assert.deepEqual(calls[0]!.params, { slug: "charter" });
});

test("the course is found by its owner, then read under that TenantId; an unlisted course is still found", async () => {
  const found = { CourseId: "C-1", PublisherTenantId: "T-ACME", Slug: "dg-air", Listable: true, VersionServed: true };
  const { mod, calls } = entitlements((sql) => (sql.includes("AS PublisherTenantId") ? found : { TenantId: "T-ACME" }));
  assert.deepEqual({ ...(await mod.findEntitledCourse("c-1", "v-1")) }, found);
  assert.equal(calls.length, 2);
  assert.equal(flat(calls[0]!.sql), "SELECT CONVERT(varchar(64), c.TenantId) AS TenantId FROM lms.Course c WHERE c.CourseId = @courseId");
  assert.deepEqual(calls[0]!.params, { courseId: "c-1" });

  const sql = flat(calls[1]!.sql);
  assert.match(sql, /WHERE c\.TenantId = @tenantId AND c\.CourseId = @courseId$/);
  assert.deepEqual(calls[1]!.params, { tenantId: "T-ACME", courseId: "c-1", versionId: "v-1" });
  assert.ok(sql.includes(`CAST(CASE WHEN ${flat(LISTABLE)} THEN 1 ELSE 0 END AS bit) AS Listable`), sql);
  assert.match(sql, /JOIN lms\.CourseVersion v ON v\.CourseId = c\.CourseId AND v\.VersionId = @versionId/, "a version of another course is not found");
  assert.match(sql, /LEFT JOIN lms\.CourseVersion cur ON cur\.VersionId = c\.CurrentVersionId AND cur\.CourseId = c\.CourseId/);
  assert.match(sql, /CAST\(CASE WHEN v\.VersionNumber <= cur\.VersionNumber THEN 1 ELSE 0 END AS bit\) AS VersionServed/);
});

test("an unknown course stops after the owner lookup", async () => {
  const { mod, calls } = entitlements(() => null);
  assert.equal(await mod.findEntitledCourse("c-1", "v-1"), null);
  assert.equal(calls.length, 1);
});

test("the slug clash counts a different course the buyer owns, subscribes to or holds a live entitlement to", async () => {
  const { mod, calls } = entitlements((sql, params) => (params.slug === "dg-air" ? { Hit: 1 } : null));
  assert.equal(await mod.buyerOwnsCourseSlug("T-CHARTER", "dg-air", "c-1"), true);
  assert.equal(await mod.buyerOwnsCourseSlug("T-CHARTER", "other", "c-1"), false);
  assert.equal(
    flat(calls[0]!.sql),
    "SELECT TOP 1 1 AS Hit FROM lms.Course clash WHERE clash.Slug = @slug AND clash.CourseId <> @courseId AND (" +
      "clash.TenantId = @tenantId " +
      "OR EXISTS (SELECT 1 FROM lms.CatalogSubscription s WHERE s.TenantId = @tenantId AND s.CourseId = clash.CourseId) " +
      "OR EXISTS (SELECT 1 FROM lms.Entitlement ent WHERE ent.TenantId = @tenantId AND ent.CourseId = clash.CourseId AND " +
      "ent.Status = 'active' AND (ent.AccessUntil IS NULL OR ent.AccessUntil >= CAST(SYSUTCDATETIME() AS date))))",
  );
  assert.deepEqual(calls[0]!.params, { tenantId: "T-CHARTER", slug: "dg-air", courseId: "c-1" });
});

test("a seat UPDATE that loses a deadlock is retried once, and only a deadlock is retried", async () => {
  const change = { entitlementId: "E-1", tenantId: "T-CHARTER", versionId: "v-1", seats: 3, accessUntil: null };
  const victim = () => Object.assign(new Error("Transaction was deadlocked"), { number: 1205 });
  const outcomes = (...answers: unknown[]) => entitlements(() => answers.shift());
  const once = outcomes(victim(), 1);
  assert.equal(await once.mod.updateEntitlement(change), true);
  assert.equal(once.calls.length, 2);
  assert.equal(once.calls[1]!.sql, once.calls[0]!.sql);
  assert.deepEqual(once.calls[1]!.params, change);

  const twice = outcomes(victim(), victim());
  await assert.rejects(twice.mod.updateEntitlement(change), /deadlocked/);
  assert.equal(twice.calls.length, 2);

  const other = outcomes(Object.assign(new Error("Timeout"), { number: -2 }));
  await assert.rejects(other.mod.updateEntitlement(change), /Timeout/);
  assert.equal(other.calls.length, 1);
});

test("a create inserts the buyer's row; a duplicate order line is false, any other failure throws", async () => {
  const row = { orderLineId: "ol_1", tenantId: "T-CHARTER", courseId: "c-1", versionId: "v-1", seats: 25, accessUntil: null };
  const ok = entitlements();
  assert.equal(await ok.mod.insertEntitlement(row), true);
  assert.equal(
    flat(ok.calls[0]!.sql),
    "INSERT INTO lms.Entitlement (OrderLineId, TenantId, CourseId, VersionId, Seats, AccessUntil) VALUES (@orderLineId, @tenantId, @courseId, @versionId, @seats, CONVERT(date, @accessUntil, 23))",
  );
  assert.deepEqual(ok.calls[0]!.params, row);

  for (const number of [2627, 2601]) {
    const dup = entitlements(() => Object.assign(new Error("Violation of UNIQUE KEY constraint"), { number }));
    assert.equal(await dup.mod.insertEntitlement(row), false, String(number));
  }
  const fk = entitlements(() => Object.assign(new Error("FOREIGN KEY constraint"), { number: 547 }));
  await assert.rejects(fk.mod.insertEntitlement(row), /FOREIGN KEY/);
});

test("the change is one UPDATE whose WHERE holds the seat guard, counted in the same statement", async () => {
  const change = { entitlementId: "E-1", tenantId: "T-CHARTER", versionId: "v-2", seats: 10, accessUntil: "2028-01-31" };
  const { mod, calls } = entitlements();
  assert.equal(await mod.updateEntitlement(change), true);
  assert.equal(calls.length, 1, "no read before the write");
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /^UPDATE e SET Seats = @seats, VersionId = @versionId, AccessUntil = CONVERT\(date, @accessUntil, 23\),/);
  assert.match(sql, /Status = CASE WHEN @seats = 0 THEN 'closed' ELSE 'active' END/);
  assert.match(sql, /ClosedAt = CASE WHEN @seats = 0 THEN SYSUTCDATETIME\(\) ELSE NULL END/);
  assert.match(sql, /UpdatedAt = SYSUTCDATETIME\(\)/);
  assert.ok(
    sql.endsWith(
      `FROM lms.Entitlement e WHERE e.EntitlementId = @entitlementId AND e.TenantId = @tenantId AND e.Status = 'active' AND @seats >= ${LOCKED_LIVE_COUNT}`,
    ),
    sql,
  );
  assert.deepEqual(calls[0]!.params, change);
});

test("an UPDATE that changed no row is false", async () => {
  const { mod } = entitlements(() => 0);
  assert.equal(await mod.updateEntitlement({ entitlementId: "E-1", tenantId: "T-CHARTER", versionId: "v-1", seats: 1, accessUntil: null }), false);
});
