import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as publishPlan from "@/lib/builder/publish-plan";
import { DraftDoc } from "@/lib/schema/draft";

// Publishing is one batch: it re-checks the draft under lock, writes a new
// version with fresh rows, and only then moves the course to it. Nothing
// already published is updated or deleted.

const source = readFileSync(new URL("./course-publish.ts", import.meta.url), "utf8");

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const REF = { draftId: DRAFT, revision: 3 };

const doc = DraftDoc.parse({
  meta: { title: "Ramp safety" },
  lessons: [{ key: "l1", title: "One", blocks: [{ kind: "text", key: "b1", markdown: "Hi" }] }],
});

interface Call { sql: string; params: Record<string, unknown> }

function load(opts: { draft?: { revision: number; doc: DraftDoc } | null; outcome?: unknown }) {
  const calls: Call[] = [];
  const draftReads: unknown[][] = [];
  const db = {
    queryOne: async (sql: string, params: Record<string, unknown> = {}) => {
      calls.push({ sql, params });
      return opts.outcome === undefined ? { Outcome: "published", VersionNumber: 2 } : opts.outcome;
    },
  };
  const getDraft = async (...args: unknown[]) => {
    draftReads.push(args);
    const draft = opts.draft === undefined ? { revision: 3, doc } : opts.draft;
    return draft && { courseId: COURSE, draftId: DRAFT, slug: "ramp-safety", status: "published", baseVersionId: null, updatedAt: new Date(0), updatedBy: "a", ...draft };
  };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = {
    "node:crypto": crypto,
    "@/lib/db": db,
    "@/lib/db/course-drafts": { getDraft },
    "@/lib/builder/publish-plan": publishPlan,
  };
  const exports: any = {};
  runInNewContext(code, { exports, JSON, Promise, Error, String, require: (name: string) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; } });
  return { publishDraft: exports.publishDraft, calls, draftReads };
}

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

test("a publish is one XACT_ABORT batch scoped by the session's tenant", async () => {
  const { publishDraft, calls, draftReads } = load({});
  const result = plain(await publishDraft(TENANT, COURSE, "author@example.test", REF, "  First cut  "));
  assert.equal(result.ok, true);
  assert.equal(result.versionNumber, 2);
  assert.match(result.versionId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(draftReads, [[TENANT, COURSE]]);
  assert.equal(calls.length, 1);
  const { sql, params } = calls[0]!;
  assert.match(flat(sql), /^SET XACT_ABORT ON; SET NOCOUNT ON; BEGIN TRANSACTION;/);
  assert.match(flat(sql), /COMMIT TRANSACTION; SELECT @outcome AS Outcome, @versionNumber AS VersionNumber;$/);
  assert.equal(params.tenantId, TENANT);
  assert.equal(params.courseId, COURSE);
  assert.equal(params.revision, 3);
  assert.equal(params.draftId, DRAFT);
  assert.equal(params.versionId, result.versionId);
  assert.equal(params.changeNote, "First cut");
  for (const stmt of flat(sql).split(";").filter((s) => /\b(FROM|UPDATE|DELETE FROM) lms\.(Course|CourseDraft)\b/.test(s))) {
    assert.match(stmt, /TenantId = @tenantId/, stmt);
  }
});

test("the batch locks the course and draft, then checks revision and base before writing", () => {
  const sql = flat(source.slice(source.indexOf("const PUBLISH"), source.indexOf("export async function")));
  assert.match(sql, /FROM lms\.Course c WITH \(UPDLOCK, HOLDLOCK\) WHERE c\.TenantId = @tenantId AND c\.CourseId = @courseId/);
  assert.match(sql, /FROM lms\.CourseDraft d WITH \(UPDLOCK, HOLDLOCK\) WHERE d\.TenantId = @tenantId AND d\.CourseId = @courseId/);
  assert.match(sql, /WHEN @courseFound = 0 THEN 'not_found'/);
  assert.match(sql, /WHEN @draftFound IS NULL OR @draftFound <> @draftId OR @draftRevision <> @revision THEN 'draft_conflict'/);
  assert.match(sql, /WHEN EXISTS \(SELECT @base EXCEPT SELECT @current\) THEN 'base_moved'/);
  assert.ok(sql.indexOf("'base_moved'") < sql.indexOf("IF @outcome = 'published'"));
});

test("content rows are only inserted, and CurrentVersionId moves after all of them", () => {
  const sql = flat(source.slice(source.indexOf("const PUBLISH"), source.indexOf("export async function")));
  assert.doesNotMatch(sql, /UPDATE lms\.(Lesson|Block|Quiz|QuizQuestion|CourseVersion)\b/);
  assert.doesNotMatch(sql, /DELETE FROM lms\.(Lesson|Block|Quiz|QuizQuestion|CourseVersion)\b/);
  const order = [
    "INSERT INTO lms.CourseVersion",
    "INSERT INTO lms.Lesson",
    "INSERT INTO lms.Block",
    "INSERT INTO lms.Quiz ",
    "INSERT INTO lms.QuizQuestion",
    "CurrentVersionId = @versionId",
    "DELETE FROM lms.CourseDraft",
    "INSERT INTO lms.AuditEvent",
  ].map((marker) => sql.indexOf(marker));
  assert.ok(order.every((at) => at > 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(sql, /SELECT @versionNumber = ISNULL\(MAX\(v\.VersionNumber\), 0\) \+ 1/);
  assert.match(sql, /Status = CASE WHEN Status = 'draft' THEN 'published' ELSE Status END/);
});

test("the rows parameter carries the plan the OPENJSON reads", async () => {
  const withQuiz = DraftDoc.parse({
    meta: { title: "Ramp safety" },
    lessons: [{
      key: "l1",
      title: "One",
      blocks: [
        { kind: "text", key: "b1", markdown: "Hi" },
        { kind: "quiz", key: "q1", questions: [{ kind: "tf", promptMd: "Chocks?", correctValue: true }] },
      ],
    }],
  });
  const { publishDraft, calls } = load({ draft: { revision: 3, doc: withQuiz } });
  await publishDraft(TENANT, COURSE, "a@example.test", REF);
  const rows = JSON.parse(String(calls[0]!.params.rows));
  assert.deepEqual(Object.keys(rows), ["lessons", "blocks", "quizzes", "questions"]);
  assert.equal(rows.lessons[0].Title, "One");
  assert.equal(rows.blocks[0].LessonId, rows.lessons[0].LessonId);
  assert.equal(calls[0]!.params.changeNote, null);
  const withColumns = [...flat(source).matchAll(/OPENJSON\(@rows, '\$\.(\w+)'\) WITH \((.*?)\) j;/g)].map(
    (m) => [m[1], m[2]!.split(/,\s*(?=[A-Z])/).map((col) => col.split(" ")[0])],
  );
  assert.deepEqual(
    withColumns,
    Object.entries(rows).map(([table, list]) => [table, Object.keys((list as object[])[0]!)]),
  );
});

test("a missing draft, a stale revision or an unpublishable draft writes nothing", async () => {
  const missing = load({ draft: null });
  assert.deepEqual(plain(await missing.publishDraft(TENANT, COURSE, "a", REF)), { ok: false, reason: "not_found" });
  const stale = load({ draft: { revision: 4, doc } });
  assert.deepEqual(plain(await stale.publishDraft(TENANT, COURSE, "a", REF)), { ok: false, reason: "draft_conflict" });
  const earlier = load({});
  assert.deepEqual(plain(await earlier.publishDraft(TENANT, COURSE, "a", { draftId: "eeeeeeee-0000-0000-0000-00000000000e", revision: 3 })), { ok: false, reason: "draft_conflict" });
  const empty = load({ draft: { revision: 3, doc: DraftDoc.parse({ meta: { title: "x" }, lessons: [] }) } });
  assert.deepEqual(plain(await empty.publishDraft(TENANT, COURSE, "a", REF)), {
    ok: false,
    reason: "not_publishable",
    problems: [{ where: "Course", problem: "Add at least one lesson." }],
  });
  for (const run of [missing, stale, earlier, empty]) assert.equal(run.calls.length, 0);
});

test("the batch's own verdict is passed back", async () => {
  for (const reason of ["not_found", "draft_conflict", "base_moved"]) {
    const { publishDraft } = load({ outcome: { Outcome: reason, VersionNumber: null } });
    assert.deepEqual(plain(await publishDraft(TENANT, COURSE, "a", REF)), { ok: false, reason });
  }
  const { publishDraft } = load({ outcome: null });
  await assert.rejects(publishDraft(TENANT, COURSE, "a", REF), /unexpected outcome/);
});

test("the dashboard counts blocks of the learner's own version", () => {
  const dashboard = flat(readFileSync(new URL("./dashboard.ts", import.meta.url), "utf8"));
  const total = dashboard.slice(dashboard.indexOf("(SELECT COUNT(*) FROM lms.Block b"), dashboard.indexOf("AS TotalBlocks")).trim();
  const done = dashboard.slice(dashboard.indexOf("(SELECT COUNT(*) FROM lms.Progress p"), dashboard.indexOf("AS DoneBlocks")).trim();
  for (const part of [total, done]) assert.match(part, /AND b\.VersionId = COALESCE\(e\.VersionId, c\.CurrentVersionId\)\)$/);
});
