import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as draftOps from "@/lib/builder/draft-ops";
import * as fork from "@/lib/builder/fork";
import * as draftSchema from "@/lib/schema/draft";
import { isUniqueViolation, randomSlug, slugify } from "./course-slug";

// The preview reads the tenant's own draft, or its current version, and
// nothing else: every statement is scoped by the session's tenant and none of
// them writes.

type Handler = (sql: string, params: Record<string, unknown>) => unknown;
interface Call { kind: "query" | "queryOne" | "execute"; sql: string; params: Record<string, unknown> }

function evaluate(file: string, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, JSON, Promise, Buffer, Error, require: (name: string) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; } });
  return exports;
}

function load(handle: Handler) {
  const calls: Call[] = [];
  const record = (kind: Call["kind"]) => async (sql: string, params: Record<string, unknown> = {}) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    calls.push({ kind, sql: flat, params });
    return handle(flat, params);
  };
  const db = { query: record("query"), queryOne: record("queryOne"), execute: record("execute") };
  const drafts = evaluate("./course-drafts.ts", {
    "node:crypto": crypto,
    "@/lib/db": db,
    "@/lib/db/course-slug": { slugify, isUniqueViolation, randomSlug, ensureUniqueSlug: async (_t: string, base: string) => base },
    "@/lib/builder/draft-ops": draftOps,
    "@/lib/builder/fork": fork,
    "@/lib/schema/draft": draftSchema,
  });
  const mod = evaluate("./course-preview.ts", { "@/lib/db": db, "@/lib/db/course-drafts": drafts, "@/lib/builder/fork": fork });
  return { mod, calls };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const TENANT = "dddddddd-0000-0000-0000-00000000000a";
const COURSE = "dddddddd-0000-0000-0000-00000000000c";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const VERSION = "DDDDDDDD-0000-0000-0000-0000000000AA";
const LESSON = "DDDDDDDD-0000-0000-0000-000000000001";
const BLOCK = "DDDDDDDD-0000-0000-0000-000000000002";
const QUIZ = "DDDDDDDD-0000-0000-0000-000000000003";

const storedDoc = draftSchema.DraftDoc.parse({
  meta: { title: "Ramp safety" },
  lessons: [{ key: "l1", title: "One", blocks: [{ kind: "text", key: "b1", markdown: "Hi" }] }],
});

const draftRow = { CourseId: COURSE, DraftId: DRAFT.toUpperCase(), Slug: "ramp-safety", Status: "draft", BaseVersionId: null, Revision: 4, DocJson: JSON.stringify(storedDoc), UpdatedAt: new Date(0), UpdatedBy: "a" };
const courseRow = (version: string | null) => ({ Title: "Ramp safety", Description: "", Category: null, Tags: "[]", ScheduleKind: null, RecurrenceMonths: null, RequiresQuizPass: true, CurrentVersionId: version });
const mcq = { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "b" };

function database(opts: { draft?: unknown; own?: boolean; version?: string | null; questionJson?: string } = {}): Handler {
  return (sql, params) => {
    const own = params.tenantId === TENANT && params.courseId === COURSE;
    if (sql.includes("FROM lms.CourseDraft d JOIN lms.Course c")) return own ? opts.draft ?? null : null;
    if (sql.startsWith("SELECT c.Slug FROM lms.Course c")) return own ? { Slug: "ramp-safety" } : null;
    if (sql.startsWith("SELECT c.Title")) return own ? courseRow(opts.version === undefined ? VERSION : opts.version) : null;
    if (!own) return [];
    if (sql.includes("FROM lms.QuizQuestion qq")) return [{ QuizId: QUIZ, OrderIndex: 0, PayloadJson: opts.questionJson ?? JSON.stringify(mcq) }];
    if (sql.includes("FROM lms.Quiz q")) return [{ QuizId: QUIZ, BlockId: BLOCK, PassingScore: 75, IsExam: true }];
    if (sql.includes("FROM lms.Block b")) return [{ BlockId: BLOCK, LessonId: LESSON, OrderIndex: 0, PayloadJson: JSON.stringify({ kind: "quiz", quizId: QUIZ.toLowerCase() }) }];
    if (sql.includes("FROM lms.Lesson l")) return [{ LessonId: LESSON, Title: "One", OrderIndex: 0, EstMinutes: null }];
    throw new Error(`unexpected statement ${sql}`);
  };
}

function assertReadOnlyAndScoped(calls: Call[]) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.notEqual(call.kind, "execute", call.sql);
    assert.doesNotMatch(call.sql, /\b(INSERT|UPDATE|DELETE|MERGE)\b/i, call.sql);
    assert.equal(call.params.tenantId, TENANT, call.sql);
    assert.match(call.sql, /TenantId = @tenantId/, call.sql);
  }
}

test("an open draft is previewed as it stands, with its id and revision, in one read", async () => {
  const { mod, calls } = load(database({ draft: draftRow }));
  const source = plain(await mod.loadPreviewSource(TENANT, COURSE));
  assert.deepEqual(source, { kind: "draft", slug: "ramp-safety", draftId: DRAFT, revision: 4, doc: plain(storedDoc) });
  assertReadOnlyAndScoped(calls);
  assert.equal(calls.length, 1);
});

test("with no draft open, the current version is previewed as a draft document, read-only", async () => {
  const { mod, calls } = load(database());
  const source = plain(await mod.loadPreviewSource(TENANT, COURSE));
  assert.equal(source.kind, "published");
  assert.equal(source.versionId, VERSION.toLowerCase());
  assert.equal(source.slug, "ramp-safety");
  assert.equal(source.doc.meta.requiresQuizPass, true);
  assert.deepEqual(source.doc.lessons[0].blocks[0], { kind: "quiz", key: BLOCK.toLowerCase(), passingScore: 75, isExam: true, questions: [mcq] });
  assertReadOnlyAndScoped(calls);
});

test("a course with neither a draft nor a version has nothing to preview; another tenant's course is missing", async () => {
  const empty = load(database({ version: null }));
  assert.deepEqual(plain(await empty.mod.loadPreviewSource(TENANT, COURSE)), { kind: "nothing", slug: "ramp-safety" });
  assertReadOnlyAndScoped(empty.calls);

  const other = load(database({ draft: draftRow }));
  assert.equal(await other.mod.loadPreviewSource(TENANT, "dddddddd-0000-0000-0000-0000000000ff"), null);
  assertReadOnlyAndScoped(other.calls);
  assert.ok(other.calls.every((c) => !c.sql.includes("FROM lms.Lesson")), "nothing past the course check is read");
});

test("a draft or a version the builder can't read is a notice, not a crash", async () => {
  const draft = load(database({ draft: { ...draftRow, DocJson: "{\"meta\":{}}" } }));
  const unreadableDraft = plain(await draft.mod.loadPreviewSource(TENANT, COURSE));
  assert.equal(unreadableDraft.kind, "unreadable");
  assert.match(unreadableDraft.message, /can no longer open/);

  const version = load(database({ questionJson: "{\"kind\":\"essay\"}" }));
  const unreadableVersion = plain(await version.mod.loadPreviewSource(TENANT, COURSE));
  assert.equal(unreadableVersion.kind, "unreadable");
  assert.match(unreadableVersion.message, /Lesson 1, block 1/);
  assertReadOnlyAndScoped([...draft.calls, ...version.calls]);
});

test("the preview loader never resolves a course by slug", () => {
  const source = readFileSync(new URL("./course-preview.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gm, ""), /getCourseBySlug|@\/lib\/db\/courses/);
});
