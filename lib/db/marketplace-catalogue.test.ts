import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { parseTags } from "./courses";

// The marketplace lists a course only when its tenant is a publisher, it is published and it is
// flagged IsCatalog; the shared ForIT catalogue keeps reading forit-owned courses only.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

function fakeDb(answer: (sql: string) => unknown) {
  const calls: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => { calls.push({ sql, params: { ...params } }); return answer(sql); };
  return {
    calls,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? [],
      queryOne: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? null,
      execute: async (sql: string, params?: Record<string, unknown>) => { record(sql, params); return 1; },
    },
  };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

const RAW = {
  CourseId: "C-1", Slug: "dg-air", VersionId: "V-3", VersionNumber: 3, Title: "DG", Description: null, Category: "Dangerous goods",
  Tags: '["TDG 6.5 air", 7]', ScheduleKind: "recurring", RecurrenceMonths: 24, EstMinutes: 240,
};

function catalogue(answer: (sql: string) => unknown = () => undefined, getCourseBySlug?: (...args: unknown[]) => Promise<unknown>) {
  const { db, calls } = fakeDb(answer);
  const slugCalls: unknown[][] = [];
  const mod = load("marketplace-catalogue.ts", {
    "@/lib/db": db,
    "@/lib/db/courses": {
      parseTags,
      getCourseBySlug: async (...args: unknown[]) => {
        slugCalls.push(args);
        return getCourseBySlug ? getCourseBySlug(...args) : null;
      },
    },
  });
  return { mod, calls, slugCalls };
}

test("LISTABLE needs all three: a publisher tenant (and an active one), published, IsCatalog", () => {
  const { mod } = catalogue();
  const listable = flat(mod.LISTABLE);
  assert.match(listable, /c\.Status = 'published'/);
  assert.match(listable, /c\.IsCatalog = 1/);
  assert.match(listable, /EXISTS \(SELECT 1 FROM lms\.Tenant publisher WHERE publisher\.TenantId = c\.TenantId AND publisher\.IsPublisher = 1 AND publisher\.IsActive = 1\)/);
  assert.doesNotMatch(listable, /\bOR\b/, "every condition must hold");
});

test("a slug resolves only to an active publisher tenant", async () => {
  const { mod, calls } = catalogue(() => ({ TenantId: "T-ACME", Slug: "acme-training", Name: "Acme" }));
  assert.deepEqual({ ...(await mod.resolvePublisher("acme-training")) }, { TenantId: "T-ACME", Slug: "acme-training", Name: "Acme" });
  assert.match(flat(calls[0]!.sql), /FROM lms\.Tenant t WHERE t\.Slug = @slug AND t\.IsPublisher = 1 AND t\.IsActive = 1$/);
  assert.deepEqual(calls[0]!.params, { slug: "acme-training" });
});

test("a course id resolves only to its owner, and only when the owner is a publisher", async () => {
  const { mod, calls } = catalogue();
  assert.equal(await mod.findCoursePublisher("C-1"), null);
  assert.match(flat(calls[0]!.sql), /JOIN lms\.Tenant t ON t\.TenantId = c\.TenantId WHERE c\.CourseId = @courseId AND t\.IsPublisher = 1 AND t\.IsActive = 1$/);
  assert.deepEqual(calls[0]!.params, { courseId: "C-1" });
});

test("the list reads one publisher's listable courses at their current version", async () => {
  const { mod, calls } = catalogue(() => [RAW]);
  const rows = await mod.listListableCourses("T-ACME");
  assert.deepEqual(rows.map((r: object) => ({ ...r })), [{ ...RAW, Tags: ["TDG 6.5 air"] }]);
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /JOIN lms\.CourseVersion v ON v\.VersionId = c\.CurrentVersionId AND v\.CourseId = c\.CourseId/);
  assert.ok(sql.includes(`WHERE c.TenantId = @tenantId AND ${flat(mod.LISTABLE)}`), sql);
  assert.match(sql, /\(SELECT SUM\(l\.EstMinutes\) FROM lms\.Lesson l WHERE l\.CourseId = c\.CourseId AND l\.VersionId = v\.VersionId\) AS EstMinutes/);
  assert.match(sql, /c\.ScheduleKind, c\.RecurrenceMonths/);
  assert.deepEqual(calls[0]!.params, { tenantId: "T-ACME" });
});

test("the detail is scoped to the publisher, listable, and at the named version or the current one", async () => {
  const lessons = [{ LessonId: "L1", Title: "One", OrderIndex: 0, EstMinutes: 30, blocks: [] }];
  const { mod, calls, slugCalls } = catalogue(() => RAW, async () => ({ course: { CourseId: "c-1" }, versionId: "V-3", lessons }));
  const found = await mod.getListableCourse("T-ACME", "C-1", null);
  assert.deepEqual({ ...found.row }, { ...RAW, Tags: ["TDG 6.5 air"] });
  assert.equal(found.lessons, lessons);
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /JOIN lms\.CourseVersion v ON v\.CourseId = c\.CourseId AND v\.VersionId = COALESCE\(@versionId, c\.CurrentVersionId\)/);
  assert.ok(sql.includes(`WHERE c.TenantId = @tenantId AND c.CourseId = @courseId AND ${flat(mod.LISTABLE)}`), sql);
  assert.match(sql, /JOIN lms\.CourseVersion cur ON cur\.VersionId = c\.CurrentVersionId AND cur\.CourseId = c\.CourseId/);
  assert.match(sql, /AND v\.VersionNumber <= cur\.VersionNumber/, "a draft numbered above the current version is never served");
  assert.deepEqual(calls[0]!.params, { tenantId: "T-ACME", courseId: "C-1", versionId: null });
  assert.deepEqual(slugCalls, [["T-ACME", "dg-air", "operator", "V-3"]],
    "content loads through the player's loader, as the publisher, at the resolved version");

  await mod.getListableCourse("T-ACME", "C-1", "V-2");
  assert.equal(calls[1]!.params.versionId, "V-2");
});

test("no listable row means no content read; a slug that now names another course is not served", async () => {
  const none = catalogue(() => null);
  assert.equal(await none.mod.getListableCourse("T-ACME", "C-1", "V-9"), null);
  assert.deepEqual(none.slugCalls, []);

  const renamed = catalogue(() => RAW, async () => ({ course: { CourseId: "C-OTHER" }, versionId: "V-3", lessons: [] }));
  assert.equal(await renamed.mod.getListableCourse("T-ACME", "C-1", null), null);
});

test("the shared ForIT catalogue and its subscription gate stay forit-only", async () => {
  const { db, calls } = fakeDb((sql) => (sql.includes("SELECT 1 AS Ok") ? { Ok: 1 } : undefined));
  const shared = load("catalogue.ts", { "@/lib/db": db });
  await shared.listCatalogCourses("T-BUYER");
  await shared.isSubscribableCatalogCourse("C-1");
  for (const call of calls) {
    const sql = flat(call.sql);
    assert.match(sql, /JOIN lms\.Tenant t ON t\.TenantId = c\.TenantId AND t\.Slug = @foritSlug/);
    assert.match(sql, /c\.IsCatalog = 1 AND c\.Status = 'published'/);
    assert.doesNotMatch(sql, /IsPublisher/);
    assert.equal(call.params.foritSlug, "forit");
  }
  const source = readFileSync(new URL("./catalogue.ts", import.meta.url), "utf8");
  assert.equal(source.match(/IsPublisher = 1/g)?.length, 1, "only the IsCatalog setter may honour IsPublisher");
  assert.doesNotMatch(source, /from "@\/lib\/db\/marketplace-catalogue"/);
});

test("IsCatalog can be set by forit or by a publisher tenant, and only on the caller's own course", async () => {
  const { db, calls } = fakeDb(() => undefined);
  const shared = load("catalogue.ts", { "@/lib/db": db });
  assert.equal(await shared.setCourseCatalogPublish("T-ACME", "C-1", true), 1);
  const sql = flat(calls[0]!.sql);
  assert.match(sql, /^UPDATE lms\.Course SET IsCatalog = @isCatalog WHERE CourseId = @courseId AND TenantId = @tenantId AND TenantId IN \(SELECT TenantId FROM lms\.Tenant WHERE Slug = @foritSlug OR IsPublisher = 1\)$/);
  assert.deepEqual(calls[0]!.params, { foritSlug: "forit", tenantId: "T-ACME", courseId: "C-1", isCatalog: true });
});
