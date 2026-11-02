import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { sep } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as completion from "./completion";
import * as scope from "./course-scope";
import * as deadlock from "./deadlock";
import * as schedule from "./schedule";

// Audit 1.9: a subscribed catalogue course gets the same certificate,
// curriculum, assignment and rollup treatment as the tenant's own course,
// while learner-side rows stay on the buyer's tenant.

function load(file: string, db: Record<string, unknown>) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const modules: Record<string, unknown> = { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope, "@/lib/db/deadlock": deadlock, "@/lib/db/schedule": schedule, "node:crypto": crypto };
  runInNewContext(code, { exports, process: { env: {} }, Date, Map, Set, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")");
// Operator and admin reads use the tenant-visible scope; a learner's own
// training reads the learner-accessible one. Both admit a subscribed course.
const TENANT = flat(scope.TENANT_VISIBLE_SCOPE);
const LEARNER = flat(scope.learnerAccessibleScope());
const scoped = (sql: string, want = TENANT) =>
  assert.ok(flat(sql).includes(want), `not ${want === TENANT ? "TENANT_VISIBLE_SCOPE" : "learnerAccessibleScope"}: ${flat(sql).slice(0, 160)}`);

// Every read of lms.Curriculum (not CurriculumCourse) must filter that alias
// on this tenant: a catalogue course sits in many tenants' curricula.
function assertCurriculaTenantScoped(sql: string) {
  const s = flat(sql);
  for (const read of s.matchAll(/lms\.Curriculum (?!Course)(\w+)/g)) {
    const after = s.slice(read.index!, read.index! + 260);
    const filter = read[1] === "WHERE"
      ? /^lms\.Curriculum WHERE TenantId = @tenantId\b/
      : new RegExp(`\\b${read[1]}\\.TenantId = @tenantId\\b`);
    assert.match(after, filter, `unscoped curriculum read: ${after.slice(0, 140)}`);
  }
}

test("a subscribed catalogue course mints a certificate in the learner's tenant with the publisher's recurrence", async () => {
  const reads: string[] = [];
  let merge: { sql: string; params: any } | undefined;
  const db = load("certificates.ts", {
    queryOne: async (sql: string, params: any) => {
      reads.push(sql);
      assert.equal(params.tenantId ?? "T", "T");
      if (sql.includes("FROM lms.Course c")) assert.equal(params.learnerId, "L");
      if (sql.includes("FROM lms.Course c")) return { Title: "Dangerous Goods", ScheduleKind: "recurring", RecurrenceMonths: 24 };
      return { SerialNo: "FI-2026-00000000" };
    },
    execute: async (sql: string, params: any) => { merge = { sql, params }; return 1; },
    query: async () => [],
  });
  const cert = await db.issueCertificate("T", "L", "Learner", "PUBLISHER-COURSE");
  assert.equal(cert.SerialNo, "FI-2026-00000000");
  scoped(reads[0]!, LEARNER);
  assert.ok(merge, "certificate was not written");
  assert.equal(merge.params.tenantId, "T");
  assert.equal(merge.params.courseId, "PUBLISHER-COURSE");
  assert.ok(merge.params.expiresAt instanceof Date, "recurring course minted without an expiry");
});

test("compliance rollups include subscribed catalogue courses and read curricula only through this tenant", async () => {
  const statements: string[] = [];
  const db = load("reporting.ts", {
    query: async (sql: string, params: any) => {
      statements.push(sql);
      assert.equal(params.tenantId, "T");
      return sql.includes("TotalLearners") ? [{ TotalLearners: 0, TotalMandatoryCourses: 0, TotalMandatoryEnrollments: 0, MandatoryCompletions: 0, CertificatesValid: 0, CertificatesExpired: 0 }] : [];
    },
  });
  await db.getMandatoryCompletionSummary("T");
  await db.getMandatoryCompletionSummary("T", "CU");
  await db.getComplianceTotals("T");
  await db.getComplianceTotals("T", "CU");
  assert.equal(statements.length, 4);
  for (const sql of statements) {
    scoped(sql);
    assertCurriculaTenantScoped(sql);
    assert.doesNotMatch(flat(sql), /WHERE c\.TenantId = @tenantId AND/);
  }
  const totals = flat(statements[2]!);
  assert.equal(totals.match(/lms\.Enrollment e/g)?.length, 2);
  assert.equal(totals.match(/WHERE e\.TenantId = @tenantId/g)?.length, 2);
  assert.equal(totals.match(/cer\.TenantId = @tenantId/g)?.length, 2);
});

test("overdue, upcoming and the KPI strip treat a subscribed catalogue course as mandatory", async () => {
  const statements: string[] = [];
  const db = {
    query: async (sql: string, params: any) => { statements.push(sql); assert.equal(params.tenantId, "T"); return []; },
    queryOne: async (sql: string, params: any) => { statements.push(sql); assert.equal(params.tenantId, "T"); return { RequiredCount: 0, UpcomingCount: 0, CertificatesValid: 0 }; },
  };
  await load("overdue.ts", db).listOverdueForTenant("T");
  const dashboard = load("dashboard.ts", db);
  await dashboard.listUpcomingForLearner("T", "L");
  await dashboard.getDashboardSummary("T", "L");
  await dashboard.listOptionalForLearner("T", "L");
  assert.equal(statements.length, 4);
  // The digest finds the tenant's mandatory courses, then keeps a learner's
  // pair only when that learner can take the course.
  scoped(statements[0]!);
  scoped(statements[0]!, flat(scope.learnerAccessibleScope("l.LearnerId")));
  for (const [i, sql] of statements.entries()) {
    const s = flat(sql);
    if (i > 0) scoped(sql, LEARNER);
    assertCurriculaTenantScoped(sql);
    if (s.includes("WITH mandatory_for_tenant")) {
      assert.match(s, /cert\.TenantId = @tenantId/);
      // EXISTS, not a join: a course mandatory in two curricula is one row.
      assert.ok(s.includes(flat(scope.MANDATORY_FOR_TENANT)));
      assert.doesNotMatch(s, /JOIN lms\.CurriculumCourse cc ON cc\.CourseId = c\.CourseId/);
    }
  }
});

test("an operator can assign a subscribed catalogue course", async () => {
  let courseSql = "";
  let insert: any;
  const db = load("assignments.ts", {
    queryOne: async (sql: string, params: any) => {
      if (sql.includes("FROM lms.Learner")) { assert.equal(params.tenantId, "T"); return { LearnerId: "L", Email: "pilot@example.test", DisplayName: "Pilot" }; }
      if (sql.includes("FROM lms.Course c")) { courseSql = sql; return { CourseId: "PUBLISHER-COURSE", Title: "Dangerous Goods", CurrentVersionId: "V3" }; }
      if (sql.includes("INSERT INTO lms.CourseAssignment")) { insert = params; return { AssignmentId: "A" }; }
      return null;
    },
    execute: async () => 1,
    query: async () => [],
  });
  const result = await db.upsertCourseAssignment({ tenantId: "T", learnerEmail: "pilot@example.test", courseSlug: "dangerous-goods", assignedBy: "admin@example.test" });
  scoped(courseSql);
  assert.equal(result.created, true);
  assert.equal(result.versionId, "V3");
  assert.equal(insert.tenantId, "T");
  assert.equal(insert.courseId, "PUBLISHER-COURSE");
});

test("the curriculum accepts a subscribed catalogue course and drops it after unsubscribe", async () => {
  let listing = "";
  const db = load("curriculum.ts", {
    query: async (sql: string) => { listing = sql; return []; },
    queryOne: async () => null,
    execute: async () => 1,
  });
  await db.getDefaultCurriculumCourses("T");
  scoped(listing);
  assertCurriculaTenantScoped(listing);
  const route = readFileSync(new URL("../../app/api/admin/curriculum/route.ts", import.meta.url), "utf8");
  assert.match(flat(route), /WHERE c\.CourseId = @courseId AND \$\{TENANT_VISIBLE_SCOPE\}/);
  assert.doesNotMatch(route, /WHERE CourseId = @courseId AND TenantId = @tenantId/);
});

test("a tenant's own course shadows a subscribed catalogue course with the same slug", async () => {
  for (const SCOPE of [TENANT, LEARNER]) assert.match(SCOPE, /c\.TenantId = @tenantId OR \(c\.CourseId IN \(SELECT CourseId FROM lms\.CatalogSubscription WHERE TenantId = @tenantId\) AND NOT EXISTS \(SELECT 1 FROM lms\.Course own_course WHERE own_course\.TenantId = @tenantId AND own_course\.Slug = c\.Slug\)\)/);
  const listing = flat(readFileSync(new URL("./courses.ts", import.meta.url), "utf8"));
  assert.match(listing, /OR \(\$\{SUBSCRIBED_IN_SCOPE\} AND c\.Status = 'published'\)/);

  let probe: { sql: string; params: any } | undefined;
  const catalogue = load("catalogue.ts", {
    queryOne: async (sql: string, params: any) => { probe = { sql, params }; return { Ok: 1 }; },
    query: async () => [],
    execute: async () => 1,
  });
  assert.equal(await catalogue.ownCourseUsesCatalogSlug("T", "PUBLISHER-COURSE"), true);
  assert.match(flat(probe!.sql), /own_course\.Slug = catalogue_course\.Slug AND own_course\.TenantId = @tenantId/);
  assert.deepEqual({ ...probe!.params }, { tenantId: "T", courseId: "PUBLISHER-COURSE" });

  const route = flat(readFileSync(new URL("../../app/api/admin/catalogue/route.ts", import.meta.url), "utf8"));
  const refused = route.indexOf("ownCourseUsesCatalogSlug(gate.tenantId, body.courseId)");
  assert.ok(refused > 0 && refused < route.indexOf("await subscribeToCatalogCourse("));
  assert.match(route, /code: "slug_conflict", \}, \{ status: 409 \}/);

  const slugGuard = flat(readFileSync(new URL("./course-slug.ts", import.meta.url), "utf8"));
  assert.match(slugGuard, /WHERE c\.Slug = @slug AND \(c\.TenantId = @tenantId OR c\.CourseId IN \(SELECT CourseId FROM lms\.CatalogSubscription WHERE TenantId = @tenantId\) OR \$\{ENTITLED_TO_TENANT\}\)/);
  // Every file that inserts a lms.Course row. The seed loader writes the fixed
  // slugs of its starter courses keyed by (TenantId, Slug); every other course
  // is created by createCourse, which takes its slug through ensureUniqueSlug.
  const root = new URL("../../", import.meta.url);
  const code = ["app", "components", "db", "lib", "scripts"].flatMap((dir) =>
    (readdirSync(new URL(dir, root), { recursive: true }) as string[])
      .map((file) => `${dir}/${file.split(sep).join("/")}`)
      .filter((file) => /\.(ts|tsx|mjs|js)$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.includes("node_modules/")),
  );
  const creators = code.filter((file) => /\b(INSERT (INTO )?|MERGE (INTO )?)lms\.Course \(/.test(flat(readFileSync(new URL(file, root), "utf8"))));
  assert.deepEqual(creators.sort(), ["db/seed/course-seed.ts", "lib/db/course-drafts.ts"]);
  const drafts = flat(readFileSync(new URL("./course-drafts.ts", import.meta.url), "utf8"));
  assert.match(drafts, /import \{ [^}]*ensureUniqueSlug[^}]* \} from "@\/lib\/db\/course-slug"/);
  assert.match(drafts, /export async function createCourse\(.*const slug = await ensureUniqueSlug\(tenantId, base\);/);
  const aiAuthoring = flat(readFileSync(new URL("../ai/authoring/job.ts", import.meta.url), "utf8"));
  assert.match(aiAuthoring, /import \{ createCourse, IngestionNotHeldError \} from "@\/lib\/db\/course-drafts"/);
  assert.match(aiAuthoring, /await createCourse\(tenantId, createdBy, \{/);
});

test("catalogue rows report their learners but not the publisher's author view", async () => {
  const statements: string[] = [];
  const admin = load("courseAdmin.ts", {
    queryOne: async (sql: string, params: any) => { statements.push(sql); assert.equal(params.tenantId, "T"); return { CourseId: "C", Title: "DG", Slug: "dg", Status: "published" }; },
    query: async (sql: string, params: any) => { statements.push(sql); assert.equal(params.tenantId, "T"); return []; },
  });
  assert.deepEqual({ ...(await admin.resolveCourseInScope("T", "dg")) }, { courseId: "C", title: "DG", slug: "dg", status: "published" });
  scoped(statements[0]!);
  await admin.listCourseVersions("T", "C");
  assert.match(flat(statements[1]!), /e\.VersionId = v\.VersionId AND e\.TenantId = @tenantId\) AS EnrollmentCount/);

  const reads = readFileSync(new URL("../api/reads.ts", import.meta.url), "utf8");
  assert.match(reads, /const course = await resolveCourseInScope\(tenantId, slug\);/);
  assert.doesNotMatch(reads, /resolveCourseAdmin/);
  const dashboard = flat(readFileSync(new URL("../../app/admin/dashboard/page.tsx", import.meta.url), "utf8"));
  assert.match(dashboard, /row\.isCatalogue \? \(<span className="font-medium">\{row\.title\}<\/span>/);
});

test("migration 0025 certifies catalogue completions once, as of the completion date", () => {
  const sql = flat(readFileSync(new URL("../../db/migrations/0025_catalogue_certificates.sql", import.meta.url), "utf8"));
  assert.match(sql, /INSERT INTO lms\.Certificate/);
  assert.match(sql, /c\.Title, l\.DisplayName, e\.CompletedAt,/);
  assert.match(sql, /JOIN lms\.Learner l ON l\.LearnerId = e\.LearnerId AND l\.TenantId = e\.TenantId/);
  assert.match(sql, /WHERE e\.CompletedAt IS NOT NULL AND c\.TenantId <> e\.TenantId AND NOT EXISTS/);
  assert.match(sql, /WHEN c\.ScheduleKind = 'annual' THEN CAST\(DATEFROMPARTS\(YEAR\(e\.CompletedAt\) \+ 1, 1, 31\)/);
  assert.match(sql, /WHEN c\.ScheduleKind = 'recurring' AND c\.RecurrenceMonths > 0 THEN DATEADD\(MONTH, c\.RecurrenceMonths, e\.CompletedAt\)/);
});
