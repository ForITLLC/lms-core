import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import * as crypto from "node:crypto";
import ts from "typescript";
import * as draftOps from "@/lib/builder/draft-ops";
import * as fork from "@/lib/builder/fork";
import * as draftSchema from "@/lib/schema/draft";
import { isUniqueViolation, randomSlug, slugify } from "./course-slug";

// The builder's drafts are scoped by the session's tenant in every statement,
// and a save made against an older revision is refused, never merged.

const source = readFileSync(new URL("./course-drafts.ts", import.meta.url), "utf8");

type Handler = (sql: string, params: Record<string, unknown>) => unknown;
interface Call { kind: "query" | "queryOne" | "execute"; sql: string; params: Record<string, unknown> }

function load(handle: Handler) {
  const calls: Call[] = [];
  const record = (kind: Call["kind"]) => async (sql: string, params: Record<string, unknown> = {}) => {
    const flat = sql.replace(/\s+/g, " ").trim();
    calls.push({ kind, sql: flat, params });
    return handle(flat, params);
  };
  const db = { query: record("query"), queryOne: record("queryOne"), execute: record("execute") };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const modules: Record<string, unknown> = {
    "node:crypto": crypto,
    "@/lib/db": db,
    "@/lib/db/course-slug": { slugify, isUniqueViolation, randomSlug, ensureUniqueSlug: async (_tenantId: string, base: string) => base },
    "@/lib/builder/draft-ops": draftOps,
    "@/lib/builder/fork": fork,
    "@/lib/schema/draft": draftSchema,
  };
  const exports: any = {};
  runInNewContext(code, { exports, JSON, Promise, Buffer, Error, require: (name: string) => { if (!(name in modules)) throw new Error(`unexpected import ${name}`); return modules[name]; } });
  return { mod: exports, calls };
}

// Results come from the vm's realm; compare them as plain data.
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const COURSE = "c0c0c0c0-0000-0000-0000-00000000000c";
const VERSION = "AAAAAAAA-0000-0000-0000-0000000000AA";
const DRAFT = "dddddddd-0000-0000-0000-00000000000d";
const REF = { draftId: DRAFT, revision: 3 };

const storedDoc = draftSchema.DraftDoc.parse({
  meta: { title: "Ramp safety" },
  lessons: [{ key: "l1", title: "One", blocks: [{ kind: "text", key: "b1", markdown: "Hi" }] }],
});

const draftRow = (revision = 3) => ({
  CourseId: COURSE.toUpperCase(),
  DraftId: DRAFT.toUpperCase(),
  Slug: "ramp-safety",
  Status: "published",
  BaseVersionId: VERSION,
  Revision: revision,
  DocJson: JSON.stringify(storedDoc),
  UpdatedAt: new Date(0),
  UpdatedBy: "author@example.test",
});

function assertTenantScoped(calls: Call[]) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.params.tenantId, TENANT, call.sql);
    assert.match(call.sql, /TenantId = @tenantId|VALUES \(@courseId, @tenantId/, call.sql);
  }
}

test("every draft statement is scoped by the session's tenant", async () => {
  const { mod, calls } = load((sql) => {
    if (sql.includes("OUTPUT inserted.Revision")) return { Revision: 4 };
    if (sql.includes("FROM lms.CourseDraft d JOIN lms.Course c")) return draftRow();
    if (sql.startsWith("SELECT c.Title")) return { Title: "Ramp safety", Description: null, Category: null, Tags: null, ScheduleKind: null, RecurrenceMonths: null, RequiresQuizPass: false, CurrentVersionId: VERSION };
    if (sql.startsWith("SELECT CONVERT(varchar(36), c.CourseId)")) return [];
    if (sql.startsWith("SELECT")) return [];
    return 1;
  });
  await mod.listAuthorCourses(TENANT);
  await mod.createCourse(TENANT, "author@example.test", { title: "Ramp Safety!" });
  await mod.getDraft(TENANT, COURSE);
  await mod.openDraft(TENANT, COURSE, "author@example.test");
  await mod.editDraft(TENANT, COURSE, "author@example.test", REF, [{ op: "updateLesson", lessonKey: "l1", title: "Uno" }]);
  await mod.discardDraft(TENANT, COURSE, REF);
  await mod.loadOwnVersion(TENANT, COURSE);
  assertTenantScoped(calls);
});

test("a new course is a draft-status course row and an empty draft, written together", async () => {
  const { mod, calls } = load(() => 1);
  const created = await mod.createCourse(TENANT, "author@example.test", { title: "Ramp Safety!", category: "ops" });
  assert.equal(created.slug, "ramp-safety");
  assert.equal(calls.length, 1);
  const [insert] = calls;
  assert.match(insert!.sql, /^SET XACT_ABORT ON; BEGIN TRANSACTION; INSERT INTO lms\.Course .* 'draft'.*INSERT INTO lms\.CourseDraft .*COMMIT TRANSACTION;$/);
  assert.deepEqual(JSON.parse(String(insert!.params.doc)), { meta: { title: "Ramp Safety!", description: "", category: "ops", tags: [], scheduleKind: null, recurrenceMonths: null, requiresQuizPass: false }, lessons: [] });
});

test("a new course can start with lessons: still one draft-status insert, the lessons in its draft, no version", async () => {
  const { mod, calls } = load(() => 1);
  const lessons = [
    { key: "dddddddd-0000-0000-0000-000000000001", title: "One", estMinutes: 10, blocks: [
      { kind: "text", key: "dddddddd-0000-0000-0000-000000000002", markdown: "Hi" },
      { kind: "quiz", key: "dddddddd-0000-0000-0000-000000000003", questions: [{ kind: "tf", promptMd: "Sky is blue?", correctValue: true }] },
    ] },
  ];
  await mod.createCourse(TENANT, "author@example.test", { title: "Ramp Safety", description: "d", slug: "ramp-safety", lessons });
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /^SET XACT_ABORT ON; BEGIN TRANSACTION; INSERT INTO lms\.Course .* 'draft'.*INSERT INTO lms\.CourseDraft \(CourseId, TenantId, BaseVersionId, DocJson, CreatedBy, UpdatedBy\) VALUES \(@courseId, @tenantId, NULL, @doc, @by, @by\); COMMIT TRANSACTION;$/);
  assert.doesNotMatch(calls[0]!.sql, /CourseVersion|CurrentVersionId|lms\.(Lesson|Block|Quiz|QuizQuestion)\b/);
  assertTenantScoped(calls);
  const doc = JSON.parse(String(calls[0]!.params.doc));
  assert.deepEqual(doc.lessons, [{ ...lessons[0], blocks: [lessons[0]!.blocks[0], { ...lessons[0]!.blocks[1], passingScore: 70, isExam: false }] }]);
  assert.deepEqual(draftSchema.DraftDoc.parse(doc), doc);
});

test("a course made for an AI authoring job stamps the job in the same transaction, only while the worker holds it and it has no course", async () => {
  const INGESTION = "abababab-0000-0000-0000-0000000000ab";
  const LEASE = "1e1e1e1e-0000-0000-0000-00000000001e";
  const held = load(() => ({ Created: true }));
  const created = await held.mod.createCourse(TENANT, "author@example.test", { title: "Ramp Safety", ingestion: { ingestionId: INGESTION, leaseToken: LEASE } });
  assert.equal(held.calls.length, 1);
  const [batch] = held.calls;
  assert.equal(batch!.kind, "queryOne");
  assert.match(batch!.sql, new RegExp([
    "^SET XACT_ABORT ON; BEGIN TRANSACTION; IF EXISTS \\(SELECT 1 FROM lms\\.AssetIngestion WITH \\(UPDLOCK, HOLDLOCK\\)",
    " WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken AND Status = 'running' AND ResultCourseId IS NULL\\)",
    " BEGIN INSERT INTO lms\\.Course .* 'draft'.*INSERT INTO lms\\.CourseDraft .*",
    "UPDATE lms\\.AssetIngestion SET ResultCourseId = @courseId, UpdatedAt = SYSUTCDATETIME\\(\\) WHERE IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken;",
    " COMMIT TRANSACTION; SELECT CAST\\(1 AS BIT\\) AS Created; END ELSE BEGIN COMMIT TRANSACTION; SELECT CAST\\(0 AS BIT\\) AS Created; END$",
  ].join("")));
  assert.deepEqual([batch!.params.ingestionId, batch!.params.leaseToken, batch!.params.courseId], [INGESTION, LEASE, created.courseId]);
  assertTenantScoped(held.calls);

  const taken = load(() => ({ Created: false }));
  await assert.rejects(
    taken.mod.createCourse(TENANT, "author@example.test", { title: "Ramp Safety", ingestion: { ingestionId: INGESTION, leaseToken: LEASE } }),
    (e: unknown) => e instanceof taken.mod.IngestionNotHeldError,
  );
  assert.equal(taken.calls.length, 1);
});

test("a new course can't start with a package block or a lesson the draft schema refuses, and nothing is written", async () => {
  const pkg = { kind: "package", key: "b1", launchableId: "dddddddd-0000-0000-0000-000000000004", title: "SCO", standard: "scorm12" };
  const ftp = { kind: "image", key: "b1", url: "ftp://example.test/a.png", alt: "" };
  for (const [block, error] of [[pkg, /package block/], [ftp, /https:\/\//]] as const) {
    const { mod, calls } = load(() => 1);
    await assert.rejects(mod.createCourse(TENANT, "a@example.test", { title: "Ramp", lessons: [{ key: "l1", title: "One", estMinutes: null, blocks: [block] }] }), error);
    assert.equal(calls.length, 0);
  }
});

test("a write that lands after someone else's save is a conflict; a vanished draft is not_found", async () => {
  for (const [current, reason] of [[{ Revision: 5 }, "conflict"], [null, "not_found"]] as const) {
    const { mod, calls } = load((sql) => {
      if (sql.includes("JOIN lms.Course c")) return draftRow(3);
      if (sql.includes("OUTPUT inserted.Revision")) return null;
      return current;
    });
    assert.deepEqual(plain(await mod.editDraft(TENANT, COURSE, "a@example.test", REF, [{ op: "updateLesson", lessonKey: "l1", title: "Uno" }])), { ok: false, reason });
    const update = calls.find((c) => c.sql.startsWith("UPDATE"))!;
    assert.match(update.sql, /WHERE d\.TenantId = @tenantId AND d\.CourseId = @courseId AND d\.DraftId = @draftId AND d\.Revision = @revision/);
    assert.equal(update.params.revision, 3);
    assert.equal(update.params.draftId, DRAFT);
  }
});

test("a tab holding an earlier draft at the same revision is a conflict, and can't discard the new one", async () => {
  const next = load((sql) => {
    if (sql.includes("JOIN lms.Course c")) return draftRow(3);
    if (sql.startsWith("SELECT d.Revision")) return { Revision: 3 };
    return 0;
  });
  const earlier = { draftId: "eeeeeeee-0000-0000-0000-00000000000e", revision: 3 };
  assert.deepEqual(plain(await next.mod.editDraft(TENANT, COURSE, "a@example.test", earlier, [{ op: "removeLesson", lessonKey: "l1" }])), { ok: false, reason: "conflict" });
  assert.equal(next.calls.some((c) => c.sql.startsWith("UPDATE")), false);
  assert.deepEqual(plain(await next.mod.discardDraft(TENANT, COURSE, earlier)), { ok: false, reason: "conflict" });
  const del = next.calls.find((c) => c.sql.startsWith("DELETE"))!;
  assert.match(del.sql, /WHERE TenantId = @tenantId AND CourseId = @courseId AND DraftId = @draftId AND Revision = @revision$/);
  assert.equal(del.params.draftId, earlier.draftId);
  assert.equal(del.params.revision, 3);
});

test("discard deletes only at the revision the author last saw: stale is a conflict, a vanished draft not_found", async () => {
  for (const [removed, current, expected] of [
    [1, { Revision: 3 }, { ok: true }],
    [0, { Revision: 4 }, { ok: false, reason: "conflict" }],
    [0, null, { ok: false, reason: "not_found" }],
  ] as const) {
    const { mod, calls } = load((sql) => (sql.startsWith("DELETE") ? removed : current));
    assert.deepEqual(plain(await mod.discardDraft(TENANT, COURSE, REF)), expected);
    const del = calls.find((c) => c.sql.startsWith("DELETE"))!;
    assert.deepEqual({ ...del.params }, { tenantId: TENANT, courseId: COURSE, draftId: DRAFT, revision: 3 });
    assert.equal(calls.some((c) => c.sql.includes("DocJson")), false);
    assertTenantScoped(calls);
  }
});

test("a stored draft the schema no longer accepts is an UnreadableDraftError naming its id and revision, not a crash", async () => {
  for (const DocJson of [
    JSON.stringify({ ...storedDoc, lessons: [{ key: "l1", title: "One", blocks: [{ kind: "embed", key: "b1", url: "javascript:alert(1)", provider: "other" }] }] }),
    "{not json",
  ]) {
    const { mod } = load((sql) => (sql.includes("JOIN lms.Course c") ? { ...draftRow(5), DocJson } : null));
    await assert.rejects(mod.getDraft(TENANT, COURSE), (e: unknown) => {
      const named = e as { constructor: { name: string }; draftId?: string; revision?: number };
      return e instanceof fork.UnreadableVersionError && named.constructor.name === "UnreadableDraftError" && named.draftId === DRAFT && named.revision === 5;
    });
    await assert.rejects(mod.editDraft(TENANT, COURSE, "a@example.test", REF, [{ op: "removeLesson", lessonKey: "l1" }]), fork.UnreadableVersionError);
  }
});

test("only editDraft writes a draft, so package blocks stay read-only", () => {
  const { mod } = load(() => null);
  assert.equal(mod.saveDraft, undefined);
  assert.equal(mod.writeDraft, undefined);
  assert.doesNotMatch(source, /export async function (saveDraft|writeDraft)/);
});

test("an edit applies its ops to the stored draft and saves over the revision it was made against", async () => {
  const stale = load((sql) => (sql.includes("JOIN lms.Course c") ? draftRow(4) : null));
  assert.deepEqual(plain(await stale.mod.editDraft(TENANT, COURSE, "a@example.test", REF, [{ op: "removeLesson", lessonKey: "l1" }])), { ok: false, reason: "conflict" });
  assert.equal(stale.calls.some((c) => c.sql.startsWith("UPDATE")), false);

  const bad = load((sql) => (sql.includes("JOIN lms.Course c") ? draftRow() : null));
  const refused = await bad.mod.editDraft(TENANT, COURSE, "a@example.test", REF, [{ op: "removeLesson", lessonKey: "nope" }]);
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, "invalid");
  assert.equal(bad.calls.some((c) => c.sql.startsWith("UPDATE")), false);

  const good = load((sql) => (sql.includes("OUTPUT inserted.Revision") ? { Revision: 4 } : draftRow()));
  const saved = await good.mod.editDraft(TENANT, COURSE, "a@example.test", REF, [{ op: "updateLesson", lessonKey: "l1", title: "Uno" }]);
  assert.equal(saved.ok, true);
  assert.equal(saved.revision, 4);
  assert.equal(saved.draftId, DRAFT);
  const update = good.calls.find((c) => c.sql.startsWith("UPDATE"))!;
  assert.equal(JSON.parse(String(update.params.doc)).lessons[0].title, "Uno");
});

test("opening a draft copies the current version once, and only while it is still current", async () => {
  let inserted = false;
  const { mod, calls } = load((sql) => {
    if (sql.includes("FROM lms.CourseDraft d JOIN lms.Course c")) return inserted ? draftRow(1) : null;
    if (sql.startsWith("SELECT c.Title")) return { Title: "Ramp safety", Description: "d", Category: null, Tags: null, ScheduleKind: null, RecurrenceMonths: null, RequiresQuizPass: false, CurrentVersionId: VERSION };
    if (sql.includes("FROM lms.Lesson l")) return [{ LessonId: "11111111-1111-1111-1111-111111111111", Title: "One", OrderIndex: 0, EstMinutes: null }];
    if (sql.includes("FROM lms.Block b JOIN")) return [{ BlockId: "22222222-2222-2222-2222-222222222222", LessonId: "11111111-1111-1111-1111-111111111111", OrderIndex: 0, PayloadJson: "{\"kind\":\"text\",\"markdown\":\"Hi\"}" }];
    if (sql.startsWith("INSERT INTO lms.CourseDraft")) { inserted = true; return 1; }
    return [];
  });
  const draft = await mod.openDraft(TENANT, COURSE, "a@example.test");
  assert.equal(draft.revision, 1);
  assert.equal(draft.courseId, COURSE);
  const insert = calls.find((c) => c.sql.startsWith("INSERT INTO lms.CourseDraft"))!;
  assert.match(insert.sql, /c\.CurrentVersionId = @versionId/);
  assert.match(insert.sql, /NOT EXISTS \(SELECT 1 FROM lms\.CourseDraft d WITH \(UPDLOCK, HOLDLOCK\)/);
  assert.equal(insert.params.versionId, VERSION.toLowerCase());
  assert.equal(JSON.parse(String(insert.params.doc)).lessons[0].blocks[0].markdown, "Hi");
  for (const read of calls.filter((c) => c.kind === "query")) assert.equal(read.params.versionId, VERSION);
});

test("another tenant's course opens as not found and writes nothing", async () => {
  const { mod, calls } = load(() => null);
  assert.equal(await mod.openDraft(TENANT, COURSE, "a@example.test"), null);
  assert.equal(calls.some((c) => c.kind === "execute"), false);
});

test("the builder never reads through getCourseBySlug, which resolves other tenants' courses", () => {
  assert.doesNotMatch(source, /from "@\/lib\/db\/courses"/);
  assert.doesNotMatch(source, /getCourseBySlug\(/);
});

const require = createRequire(import.meta.url);
const { splitBatches } = require("../../scripts/run-migration.cjs") as { splitBatches: (content: string) => string[] };
const migration = splitBatches(readFileSync(new URL("../../db/migrations/0029_course_drafts.sql", import.meta.url), "utf8")).map((b) => b.replace(/\s+/g, " "));

test("0029 is guarded batch by batch and ties each draft to its own tenant's course", () => {
  assert.equal(migration.length, 3);
  for (const batch of migration) assert.match(batch, /\bIF (NOT )?EXISTS \(|\bIF OBJECT_ID\(/, batch.slice(0, 120));
  const table = migration.find((b) => b.includes("CREATE TABLE lms.CourseDraft"))!;
  assert.match(table, /FOREIGN KEY \(TenantId, CourseId\) REFERENCES lms\.Course \(TenantId, CourseId\)/);
  assert.match(table, /CHECK \(ISJSON\(DocJson\) = 1\)/);
  assert.match(migration[0]!, /CREATE UNIQUE INDEX UQ_lms_Course_TenantCourse ON lms\.Course \(TenantId, CourseId\)/);
});

test("the author list returns lower-case course ids, like the draft reads", async () => {
  const { mod, calls } = load(() => []);
  await mod.listAuthorCourses(TENANT);
  assert.match(calls[0]!.sql, /^SELECT LOWER\(CONVERT\(varchar\(36\), c\.CourseId\)\) AS CourseId/);
});

test("reopening a never-published course keeps its course settings", async () => {
  const { mod, calls } = load((sql) => {
    if (sql.startsWith("SELECT c.Title")) {
      return { Title: "Ramp safety", Description: null, Category: "safety", Tags: JSON.stringify(["ramp"]), ScheduleKind: "recurring", RecurrenceMonths: 24, RequiresQuizPass: true, CurrentVersionId: null };
    }
    return null;
  });
  await assert.rejects(mod.openDraft(TENANT, COURSE, "a@example.test"), /kept changing version/);
  const insert = calls.find((c) => c.sql.startsWith("INSERT INTO lms.CourseDraft"))!;
  assert.match(insert.sql, /c\.CurrentVersionId IS NULL/);
  assert.deepEqual(JSON.parse(String(insert.params.doc)).meta, {
    title: "Ramp safety",
    description: "",
    category: "safety",
    tags: ["ramp"],
    scheduleKind: "recurring",
    recurrenceMonths: 24,
    requiresQuizPass: true,
  });
});

test("a version published while the draft opens is picked up on the next try", async () => {
  const MOVED = "BBBBBBBB-0000-0000-0000-0000000000BB";
  let reads = 0;
  let inserted = false;
  const { mod, calls } = load((sql, params) => {
    if (sql.includes("FROM lms.CourseDraft d JOIN lms.Course c")) return inserted ? draftRow(1) : null;
    if (sql.startsWith("SELECT c.Title")) {
      reads += 1;
      return { Title: "Ramp safety", Description: null, Category: null, Tags: null, ScheduleKind: null, RecurrenceMonths: null, RequiresQuizPass: false, CurrentVersionId: reads === 1 ? VERSION : MOVED };
    }
    if (sql.startsWith("INSERT INTO lms.CourseDraft")) {
      inserted = params.versionId === MOVED.toLowerCase();
      return inserted ? 1 : 0;
    }
    return [];
  });
  const draft = await mod.openDraft(TENANT, COURSE, "a@example.test");
  assert.equal(draft.revision, 1);
  assert.deepEqual(calls.filter((c) => c.sql.startsWith("INSERT")).map((c) => c.params.versionId), [VERSION.toLowerCase(), MOVED.toLowerCase()]);
});

test("a slug taken between the check and the insert gets a random suffix", async () => {
  let attempts = 0;
  const { mod, calls } = load(() => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("Violation of UNIQUE KEY constraint"), { number: 2627 });
    return 1;
  });
  const created = await mod.createCourse(TENANT, "a@example.test", { title: "Ramp Safety" });
  assert.match(created.slug, /^ramp-safety-[0-9a-f]{8}$/);
  assert.deepEqual(calls.map((c) => c.params.slug), ["ramp-safety", created.slug]);

  const other = load(() => { throw Object.assign(new Error("timeout"), { number: -2 }); });
  await assert.rejects(other.mod.createCourse(TENANT, "a@example.test", { title: "Ramp Safety" }), /timeout/);
  assert.equal(other.calls.length, 1);
});
