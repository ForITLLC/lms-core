import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as completion from "./completion";
import * as scope from "./course-scope";

// The builder's version history reads only the session tenant's own course:
// another tenant's course id is missing, and every statement filters by TenantId.

type Handler = (sql: string, params: Record<string, unknown>) => unknown;
interface Call { kind: "query" | "queryOne"; sql: string; params: Record<string, unknown> }

function transpile(file: string) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function evaluate(file: string, modules: Record<string, unknown>) {
  const exports: any = {};
  runInNewContext(transpile(file), {
    exports, Promise, Date, JSON,
    require: (name: string) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; },
  });
  return exports;
}

function load(handle: Handler) {
  const calls: Call[] = [];
  const record = (kind: Call["kind"]) => async (sql: string, params: Record<string, unknown> = {}) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    calls.push({ kind, sql: flat, params });
    return handle(flat, params);
  };
  const db = { query: record("query"), queryOne: record("queryOne") };
  const courseAdmin = evaluate("./courseAdmin.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope });
  const mod = evaluate("./course-versions.ts", { "@/lib/db": db, "@/lib/db/courseAdmin": courseAdmin });
  return { mod, calls };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const TENANT = "dddddddd-0000-0000-0000-00000000000a";
const COURSE = "dddddddd-0000-0000-0000-00000000000c";
const V1 = "DDDDDDDD-0000-0000-0000-0000000000B1";
const V2 = "DDDDDDDD-0000-0000-0000-0000000000B2";

const versionRow = (VersionId: string, VersionNumber: number, IsCurrent: number, ChangeNote: string | null = null) => ({
  VersionId,
  VersionNumber,
  PublishedAt: new Date(Date.UTC(2026, 9, VersionNumber)),
  PublishedBy: "author@example.test",
  ChangeNote,
  IsCurrent,
  LessonCount: 2,
  BlockCount: 5,
  EnrollmentCount: VersionNumber,
});

function assertTenantScoped(calls: Call[]) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.params.tenantId, TENANT, call.sql);
    assert.match(call.sql, /JOIN lms\.Course c ON c\.CourseId = v\.CourseId WHERE c\.TenantId = @tenantId|FROM lms\.Course c WHERE c\.TenantId = @tenantId/, call.sql);
  }
}

test("the history is newest first with lower-case ids, notes, counts and the live version", async () => {
  const { mod, calls } = load((sql) => {
    if (sql.includes("FROM lms.CourseVersion v")) return [versionRow(V2, 2, 1, "Adds the de-icing lesson"), versionRow(V1, 1, 0)];
    return { CourseId: COURSE.toUpperCase() };
  });
  const history = plain(await mod.getVersionHistory(TENANT, COURSE));
  assert.equal(history.currentVersionId, V2.toLowerCase());
  assert.deepEqual(history.versions.map((v: { versionId: string }) => v.versionId), [V2.toLowerCase(), V1.toLowerCase()]);
  assert.deepEqual(history.versions[0], {
    versionId: V2.toLowerCase(),
    versionNumber: 2,
    publishedAt: new Date(Date.UTC(2026, 9, 2)).toISOString(),
    publishedBy: "author@example.test",
    changeNote: "Adds the de-icing lesson",
    isCurrent: true,
    lessonCount: 2,
    blockCount: 5,
    enrollmentCount: 2,
  });
  assert.equal(history.versions[1].isCurrent, false);
  assertTenantScoped(calls);
  const list = calls.find((c) => c.sql.includes("FROM lms.CourseVersion v"))!;
  assert.match(list.sql, /ORDER BY v\.VersionNumber DESC$/);
  assert.match(list.sql, /AND v\.CourseId = @courseId/);
  assert.equal(list.params.courseId, COURSE);
});

test("another tenant's course is missing and its versions are never listed", async () => {
  const { mod, calls } = load(() => null);
  assert.equal(await mod.getVersionHistory(TENANT, COURSE), null);
  assert.equal(calls.length, 1);
  assertTenantScoped(calls);
});

test("a course never published has no versions and nothing live", async () => {
  const { mod, calls } = load((sql) => (sql.includes("FROM lms.CourseVersion v") ? [] : { CourseId: COURSE }));
  assert.deepEqual(plain(await mod.getVersionHistory(TENANT, COURSE)), { currentVersionId: null, versions: [] });
  assert.equal(calls.length, 2);
  assertTenantScoped(calls);
});
