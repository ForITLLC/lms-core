import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import { z } from "zod";
import * as blocks from "@/lib/schema/blocks";
import * as quiz from "@/lib/schema/quiz";

// A starter course an author has taken into the course builder is theirs: the
// seed neither republishes it under --force nor refreshes its catalogue fields.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";
const VERSION = "b0b0b0b0-0000-0000-0000-00000000000b";

const seed = {
  slug: "ramp-safety",
  title: "Ramp safety",
  description: "Ramp basics.",
  category: "productivity",
  lessons: [{ title: "Walkaround", estMinutes: 5, blocks: [{ kind: "text", markdown: "Check the chocks." }] }],
};

function load(builderOwned: number, moved = 1) {
  const writes: string[] = [];
  const params: Record<string, unknown>[] = [];
  const db = {
    queryOne: async (sql: string) => {
      if (/FROM lms\.Course c\b/.test(sql)) return { CourseId: COURSE, CurrentVersionId: VERSION, BuilderOwned: builderOwned };
      if (/FROM lms\.CourseVersion/.test(sql)) return { VersionId: VERSION, VersionNumber: 3 };
      return null;
    },
    execute: async (sql: string, p: Record<string, unknown> = {}) => {
      writes.push(sql.replace(/\s+/g, " ").trim());
      params.push(p);
      return /^UPDATE c SET/.test(sql.replace(/\s+/g, " ").trim()) ? moved : 1;
    },
  };
  const source = readFileSync(new URL("./course-seed.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const modules: Record<string, unknown> = {
    "node:crypto": crypto,
    zod: { z },
    "@/lib/db": db,
    "@/lib/schema/blocks": blocks,
    "@/lib/schema/quiz": quiz,
    "@/db/seed/lesson-quizzes.json": { quizzes: {} },
  };
  const exports: any = {};
  runInNewContext(code, { exports, JSON, Promise, Error, String, Array, Set, Object, Number, require: (name: string) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; } });
  return { loadCourseSeed: exports.loadCourseSeed, writes, params };
}

test("a builder-owned course is skipped untouched, even under --force", async () => {
  for (const force of [false, true]) {
    const { loadCourseSeed, writes } = load(1);
    const result = await loadCourseSeed(seed, { tenantId: TENANT, createdBy: "seed", force });
    assert.equal(result.status, "skipped");
    assert.equal(result.versionNumber, 3);
    assert.deepEqual(writes, [], `force=${force}`);
  }
});

test("a seed-managed course still gets its catalogue refresh, and --force still republishes it", async () => {
  const skip = load(0);
  assert.equal((await skip.loadCourseSeed(seed, { tenantId: TENANT, createdBy: "seed" })).status, "skipped");
  assert.equal(skip.writes.length, 1);
  assert.match(skip.writes[0]!, /SET Category = @category/);

  const forced = load(0);
  assert.equal((await forced.loadCourseSeed(seed, { tenantId: TENANT, createdBy: "seed", force: true })).status, "replaced");
  const updates = forced.writes.filter((sql) => sql.startsWith("UPDATE"));
  assert.equal(updates.length, 1, "metadata moves with the version pointer, in one statement");
  assert.match(updates[0]!, /CurrentVersionId = @versionId FROM lms\.Course c WHERE c\.TenantId = @tenantId AND c\.CourseId = @courseId AND c\.CurrentVersionId = @previousVersionId AND NOT \(EXISTS/);
  assert.equal(forced.params[forced.writes.indexOf(updates[0]!)]!.previousVersionId, VERSION);
});

test("a seed that loses a race to the builder or another publish stops without moving the course", async () => {
  const { loadCourseSeed, writes } = load(0, 0);
  await assert.rejects(loadCourseSeed(seed, { tenantId: TENANT, createdBy: "seed", force: true }), /changed while it was being seeded/);
  assert.equal(writes.filter((sql) => sql.startsWith("UPDATE")).length, 1);
});

test("builder ownership means an open draft or a builder publish in the same tenant", () => {
  const sql = readFileSync(new URL("./course-seed.ts", import.meta.url), "utf8").replace(/\s+/g, " ");
  assert.match(sql, /FROM lms\.CourseDraft d WHERE d\.TenantId = c\.TenantId AND d\.CourseId = c\.CourseId/);
  assert.match(sql, /a\.TenantId = c\.TenantId AND a\.Verb = 'course\.publish' AND a\.ObjectId = LOWER\(CONVERT\(varchar\(36\), c\.CourseId\)\)/);
});
