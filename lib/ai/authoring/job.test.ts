import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as zod from "zod";
import Anthropic from "@anthropic-ai/sdk";
import * as claude from "@/lib/ai/claude";
import * as draftOps from "@/lib/builder/draft-ops";
import * as fork from "@/lib/builder/fork";
import * as scope from "@/lib/db/course-scope";
import * as blockSchemas from "@/lib/schema/blocks";
import * as draftSchema from "@/lib/schema/draft";
import { CourseOutline } from "./outline";
import { AuthoredDraftError, toAuthoredDraft } from "./draft";
import * as usageModule from "./usage";
import * as source from "./source";
import * as extractTextModule from "./extract-text";
import * as optionsModule from "./options";
import * as safeFetchModule from "@/lib/net/safe-fetch";
import { fakeWeb, type FakePage, type FakeReply } from "@/lib/fixtures/fake-web";

// The AI authoring job runs the real queue (lib/db/ingestions.ts), the real
// createCourse and the real generateBlocks against an in-memory
// lms.AssetIngestion that reads each statement's own WHERE and SET clauses,
// so a guard missing from the SQL is missing here too. Model calls are faked;
// the errors they throw are the Anthropic SDK's own.

const TENANT = "dddddddd-0000-0000-0000-00000000000a";
const OTHER_TENANT = "eeeeeeee-0000-0000-0000-00000000000b";
const BY = "author@operator.test";
const URL_IN = "https://youtu.be/x";
const START = Date.UTC(2026, 9, 29, 12);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

function vmLoad(file: URL, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Error, Promise, JSON, String, Number, Math, Buffer, Date, setTimeout, URL, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return exports;
}

// ---- an in-memory lms.AssetIngestion and lms.Course -------------------------

type Row = Record<string, any>;
const CLAIMABLE = "((Status = 'queued' AND NotBefore <= SYSUTCDATETIME()) OR (Status = 'running' AND LeaseUntil < SYSUTCDATETIME()))";
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();

function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (list[i] === "," && depth === 0) {
      parts.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts;
}

function fakeDb() {
  const clock = { t: START };
  const rows: Row[] = [];
  const courses: { courseId: string; tenantId: string; slug: string; status: string; createdBy: string; doc: any }[] = [];
  const statements: { sql: string; params: any }[] = [];
  const faults: { before?: (sql: string) => Error | undefined; after?: (sql: string) => Error | undefined } = {};

  const matches = (cond: string, p: any, row: Row) =>
    cond.replace(CLAIMABLE, "__CLAIMABLE__").split(" AND ").every((part) => {
      if (part === "__CLAIMABLE__") {
        return (row.Status === "queued" && row.NotBefore <= clock.t)
          || (row.Status === "running" && row.LeaseUntil !== null && row.LeaseUntil < clock.t);
      }
      let m: RegExpExecArray | null;
      if ((m = /^(\w+) = @(\w+)$/.exec(part))) {
        if (!(m[2]! in p)) throw new Error(`no parameter @${m[2]}`);
        return same(row[m[1]!], p[m[2]!]);
      }
      if ((m = /^(\w+) = '(\w+)'$/.exec(part))) return row[m[1]!] === m[2];
      if ((m = /^(\w+) IS NULL$/.exec(part))) return row[m[1]!] === null;
      if ((m = /^(\w+) IS NOT NULL$/.exec(part))) return row[m[1]!] !== null;
      throw new Error(`the fake database can't read the condition: ${part}`);
    });

  const value = (expr: string, p: any, row: Row) => {
    let m: RegExpExecArray | null;
    if (expr === "NULL") return null;
    if (expr === "SYSUTCDATETIME()") return clock.t;
    if ((m = /^@(\w+)$/.exec(expr))) {
      if (!(m[1]! in p)) throw new Error(`no parameter @${m[1]}`);
      return p[m[1]!];
    }
    if ((m = /^N?'([^']*)'$/.exec(expr))) return m[1];
    if ((m = /^DATEADD\(second, @(\w+), SYSUTCDATETIME\(\)\)$/.exec(expr))) return clock.t + Number(p[m[1]!]) * 1000;
    if ((m = /^(\w+) \+ 1$/.exec(expr))) return row[m[1]!] + 1;
    if (expr === "CASE WHEN Attempts > 0 THEN Attempts - 1 ELSE 0 END") return row.Attempts > 0 ? row.Attempts - 1 : 0;
    throw new Error(`the fake database can't evaluate: ${expr}`);
  };

  const assign = (set: string, p: any, row: Row) => {
    const next = Object.fromEntries(splitTop(set).map((item) => {
      const m = /^(\w+) = (.+)$/.exec(item);
      if (!m) throw new Error(`the fake database can't read the assignment: ${item}`);
      return [m[1]!, value(m[2]!, p, row)];
    }));
    Object.assign(row, next);
  };

  const selected = (list: string, row: Row) => Object.fromEntries(splitTop(list).map((item) => {
    const m = /^CONVERT\(varchar\(36\), (\w+)\) AS (\w+)$/.exec(item);
    if (m) return [m[2]!, row[m[1]!] === null ? null : String(row[m[1]!]).toUpperCase()];
    if (!/^\w+$/.test(item)) throw new Error(`the fake database can't select: ${item}`);
    if (!(item in row)) throw new Error(`no column ${item}`);
    const v = row[item];
    return [item, /At$|NotBefore/.test(item) && typeof v === "number" ? new Date(v) : v];
  }));

  const claimOutput = (row: Row) => ({
    IngestionId: row.IngestionId.toUpperCase(), TenantId: row.TenantId.toUpperCase(), CreatedBy: row.CreatedBy,
    SourceKind: row.SourceKind, SourceRef: row.SourceRef, Stage: row.Stage, Attempts: row.Attempts,
    OptionsJson: row.OptionsJson, WorkJson: row.WorkJson, UsageJson: row.UsageJson, ResultCourseId: row.ResultCourseId?.toUpperCase() ?? null,
  });

  function apply(sql: string, p: any): { rows: unknown[]; count: number } {
    let m: RegExpExecArray | null;
    if ((m = /^INSERT INTO lms\.AssetIngestion \(([^)]*)\) VALUES \((.*)\)$/.exec(sql))) {
      const cols = splitTop(m[1]!);
      const vals = splitTop(m[2]!);
      const row: Row = {
        Stage: null, LessonsDone: 0, LessonsTotal: null, Attempts: 0, NotBefore: clock.t, LeaseUntil: null, LeaseToken: null,
        OptionsJson: null, WorkJson: null, WarningsJson: null, UsageJson: null, ResultCourseId: null, ErrorMessage: null, CreatedBy: null,
        Status: "queued", CreatedAt: clock.t, UpdatedAt: clock.t,
      };
      cols.forEach((col, i) => { row[col] = value(vals[i]!, p, row); });
      rows.push(row);
      return { rows: [], count: 1 };
    }
    if ((m = /^WITH next AS \( SELECT TOP \(1\) \* FROM lms\.AssetIngestion WITH \(UPDLOCK, READPAST, ROWLOCK\) WHERE (.*) ORDER BY NotBefore, CreatedAt \) UPDATE next SET (.*) OUTPUT .*$/.exec(sql))) {
      const next = rows.filter((row) => matches(m![1]!, p, row)).sort((a, b) => a.NotBefore - b.NotBefore || a.CreatedAt - b.CreatedAt)[0];
      if (!next) return { rows: [], count: 0 };
      assign(m[2]!, p, next);
      return { rows: [claimOutput(next)], count: 1 };
    }
    if ((m = /^UPDATE lms\.AssetIngestion WITH \(UPDLOCK, READPAST\) SET (.*) OUTPUT .* WHERE (.*)$/.exec(sql))) {
      const hit = rows.filter((row) => matches(m![2]!, p, row));
      for (const row of hit) assign(m[1]!, p, row);
      return { rows: hit.map(claimOutput), count: hit.length };
    }
    if ((m = /^UPDATE lms\.AssetIngestion SET (.*) WHERE (.*)$/.exec(sql))) {
      const hit = rows.filter((row) => matches(m![2]!, p, row));
      for (const row of hit) assign(m[1]!, p, row);
      return { rows: [], count: hit.length };
    }
    if ((m = /^SELECT (?:TOP \(@limit\) )?(.*) FROM lms\.AssetIngestion WHERE (.*?)(?: ORDER BY CreatedAt DESC)?$/.exec(sql))) {
      const hit = rows.filter((row) => matches(m![2]!, p, row)).map((row) => selected(m![1]!, row));
      return { rows: hit, count: hit.length };
    }
    if (sql.startsWith("SELECT TOP 1 c.CourseId FROM lms.Course c WHERE c.Slug = @slug AND (c.TenantId = @tenantId ")) {
      const hit = courses.filter((c) => c.slug === p.slug && c.tenantId === p.tenantId).map((c) => ({ CourseId: c.courseId }));
      return { rows: hit, count: hit.length };
    }
    if ((m = /^SET XACT_ABORT ON; BEGIN TRANSACTION; IF EXISTS \(SELECT 1 FROM lms\.AssetIngestion WITH \(UPDLOCK, HOLDLOCK\) WHERE (.*?)\) BEGIN INSERT INTO lms\.Course \(CourseId, TenantId, Title, Slug, Description, Status, Category, CreatedBy\) VALUES \(@courseId, @tenantId, @title, @slug, @description, 'draft', @category, @by\); INSERT INTO lms\.CourseDraft \(CourseId, TenantId, BaseVersionId, DocJson, CreatedBy, UpdatedBy\) VALUES \(@courseId, @tenantId, NULL, @doc, @by, @by\); UPDATE lms\.AssetIngestion SET (.*?) WHERE (.*?); COMMIT TRANSACTION; SELECT CAST\(1 AS BIT\) AS Created; END ELSE BEGIN COMMIT TRANSACTION; SELECT CAST\(0 AS BIT\) AS Created; END$/.exec(sql))) {
      if (!rows.some((row) => matches(m![1]!, p, row))) return { rows: [{ Created: false }], count: 0 };
      courses.push({ courseId: p.courseId, tenantId: p.tenantId, slug: p.slug, status: "draft", createdBy: p.by, doc: JSON.parse(p.doc) });
      for (const row of rows.filter((r) => matches(m![3]!, p, r))) assign(m[2]!, p, row);
      return { rows: [{ Created: true }], count: 1 };
    }
    throw new Error(`the fake database doesn't know: ${sql.slice(0, 160)}`);
  }

  const run = async (sql: string, params: any = {}) => {
    const text = flat(sql);
    statements.push({ sql: text, params: plain(params) });
    const before = faults.before?.(text);
    if (before) throw before;
    const result = apply(text, params);
    const after = faults.after?.(text);
    if (after) throw after;
    return result;
  };
  const db = {
    query: async (sql: string, params?: any) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: any) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: any) => (await run(sql, params)).count,
  };
  return { db, clock, rows, courses, statements, faults };
}

// ---- the model, faked ------------------------------------------------------

const lesson = (n: number) => ({ title: `Lesson ${n}`, summary: `About ${n}`, objectives: [`Explain ${n}`], estMinutes: 10 + n });
const OUTLINE = { title: "Wake turbulence", slug: "wake-turbulence", description: "Avoiding wake.", lessons: [lesson(1), lesson(2), lesson(3)] };
const text = (s: string) => ({ kind: "text", markdown: s });
const quizFor = (n: number) => [
  { kind: "mcq", promptMd: `L${n} q1`, choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }], correctChoiceId: "b" },
  { kind: "tf", promptMd: `L${n} q2`, correctValue: false },
  { kind: "short", promptMd: `L${n} q3`, rubricMd: "Names the vortex.", maxScore: 5 },
];
const goodBlocks = (n: number) => [
  text(`Intro ${n}`),
  ...(n === 1 ? [{ kind: "embed", url: "https://www.youtube.com/watch?v=x", provider: "youtube" }] : []),
  { kind: "callout", variant: "warning", markdown: `Careful ${n}` },
  text(`Body ${n}`),
];

// What each faked call spent, as callTool reports it.
const OUTLINE_USAGE = { model: "bulk-model", inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 5000, cacheReadTokens: 0 };
const BLOCKS_USAGE = { model: "reasoning-model", inputTokens: 100, outputTokens: 2000, cacheWriteTokens: 0, cacheReadTokens: 5000 };
const QUIZ_USAGE = { model: "bulk-model", inputTokens: 50, outputTokens: 300, cacheWriteTokens: 0, cacheReadTokens: 5000 };
// A three-lesson run: the outline, then each lesson's blocks and quiz.
const THREE_LESSONS = {
  "bulk-model": { calls: 4, inputTokens: 1150, outputTokens: 1100, cacheWriteTokens: 5000, cacheReadTokens: 15000 },
  "reasoning-model": { calls: 3, inputTokens: 300, outputTokens: 6000, cacheWriteTokens: 0, cacheReadTokens: 15000 },
};
const THREE_LESSON_TOKENS = "tokens in=36450 out=7100";

const apiError = { type: "error", error: { type: "rate_limit_error", message: "slow down" } };
const rateLimited = (headers: Record<string, string> = {}) => new Anthropic.RateLimitError(429, apiError, undefined, headers);
const overloaded = () => Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, {});
const refused = () => new Anthropic.BadRequestError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } }, undefined, {});

interface Fakes {
  outline?: (call: number) => unknown;
  blocks?: (n: number, call: number) => unknown[];
  onQuiz?: (n: number) => Promise<void> | void;
  onExtract?: () => void;
  pages?: Record<string, FakePage>;
}

const PAGE_URL = "https://aviation.example/wake";
const PAGE_HTML = "<html><head><title>Wake turbulence &amp; you</title><script>steal()</script></head><body><h1>Wake</h1><p>Vortices trail from wingtips.</p></body></html>";
const PAGE_DNS = { "aviation.example": ["93.184.215.14"], "intranet.example": ["10.0.0.7"] };
const PASTE = { title: "Hangar notes", text: "Chock the wheels.\nCheck the tow bar." };

function harness(fakes: Fakes = {}) {
  const store = fakeDb();
  const { db } = store;
  const courseSlug = vmLoad(new URL("../../db/course-slug.ts", import.meta.url), {
    "node:crypto": crypto, "@/lib/db": db, "@/lib/db/course-scope": scope,
  });
  const drafts = vmLoad(new URL("../../db/course-drafts.ts", import.meta.url), {
    "node:crypto": crypto, "@/lib/db": db, "@/lib/db/course-slug": courseSlug,
    "@/lib/builder/draft-ops": draftOps, "@/lib/builder/fork": fork, "@/lib/schema/draft": draftSchema,
  });
  const ingestions = vmLoad(new URL("../../db/ingestions.ts", import.meta.url), {
    "node:crypto": crypto, "@/lib/db": db, "@/lib/ai/authoring/usage": usageModule,
  });
  const calls = { extract: 0, outline: 0, blocks: [] as number[], quiz: [] as number[], extracts: [] as any[], blockPrompts: [] as string[], outlineOptions: [] as any[] };
  const blockCalls = new Map<number, number>();
  const blocks = vmLoad(new URL("./blocks.ts", import.meta.url), {
    zod, "@/lib/schema/blocks": blockSchemas, "./usage": usageModule, "./source": source,
    "@/lib/ai/claude": { MODELS: { reasoning: "reasoning-model", bulk: "bulk-model" } },
    "./util": { callTool: async (call: any) => {
      const n = Number(/Lesson (\d+) of/.exec(call.userMessage)![1]);
      calls.blocks.push(n);
      calls.blockPrompts.push(`${call.cachedSystem}\n${call.userMessage}`);
      const seen = (blockCalls.get(n) ?? 0) + 1;
      blockCalls.set(n, seen);
      return { input: { blocks: (fakes.blocks ?? goodBlocks)(n, seen) }, usage: { ...BLOCKS_USAGE, model: call.model } };
    } },
  });
  const youtube = async (url: string) => {
    calls.extract += 1;
    fakes.onExtract?.();
    return {
      kind: "youtube", title: "Video", author: "A", url, text: "the transcript", approxMinutes: 1,
      videoId: "x", thumbnailUrl: "", transcriptSource: "yt-dlp",
    };
  };
  const web = fakeWeb(PAGE_DNS, { [PAGE_URL]: { headers: { "content-type": "text/html" }, body: PAGE_HTML }, ...fakes.pages });
  const urlSource = vmLoad(new URL("./extract-url.ts", import.meta.url), {
    "@/lib/net/safe-fetch": safeFetchModule, "./extract-youtube": { extractYouTube: youtube }, "./source": source,
  });
  const runs: unknown[][] = [];
  const errors: unknown[][] = [];
  const job = vmLoad(new URL("./job.ts", import.meta.url), {
    zod,
    "@/lib/db/ingestions": ingestions,
    "@/lib/db/course-drafts": drafts,
    "@/lib/logging": {
      recordServiceRun: async (...args: unknown[]) => { runs.push(args); },
      recordError: async (...args: unknown[]) => { errors.push(args); },
    },
    "@/lib/ai/claude": { transientAiError: claude.transientAiError },
    "./extract-youtube": { extractYouTube: youtube },
    "./extract-text": extractTextModule,
    "./extract-url": { ...urlSource, extractUrl: (address: string) =>
      urlSource.extractUrl(address, { fetch: { resolve: web.resolve, transport: web.transport } }) },
    "./source": source,
    "./outline": { CourseOutline, generateOutline: async (extract: unknown, options: unknown) => {
      calls.outline += 1;
      calls.extracts.push(plain(extract));
      calls.outlineOptions.push(plain(options));
      return { ...(fakes.outline ? fakes.outline(calls.outline) as object : OUTLINE), usage: OUTLINE_USAGE };
    } },
    "./blocks": blocks,
    "./quiz": { generateQuiz: async ({ lessonIndex }: { lessonIndex: number }) => {
      calls.quiz.push(lessonIndex + 1);
      await fakes.onQuiz?.(lessonIndex + 1);
      return { questions: quizFor(lessonIndex + 1), usage: QUIZ_USAGE };
    } },
    "./draft": { toAuthoredDraft },
    "./options": optionsModule,
    "./usage": usageModule,
  });
  const now = () => store.clock.t;
  const enqueue = (tenantId = TENANT) =>
    ingestions.enqueueIngestion(tenantId, { createdBy: BY, sourceKind: "youtube", sourceRef: URL_IN, options: {} }) as Promise<string>;
  const enqueueSource = (input: unknown, tenantId = TENANT) =>
    ingestions.enqueueIngestion(tenantId, job.ingestionInput(BY, input)) as Promise<string>;
  const next = (options: Record<string, unknown> = {}) => job.processNextIngestion({ now, ...options });
  const row = (id: string) => store.rows.find((r) => r.IngestionId === id)!;
  return { ...store, job, ingestions, drafts, calls, runs, errors, web, now, enqueue, enqueueSource, next, row };
}

const minutes = (n: number) => n * 60_000;

// ---- A1's guarantees, now through the job ------------------------------------

test("the job saves the generated course as one course builder draft: lessons, blocks and questions in order, unique editor keys", async () => {
  const app = harness();
  const id = await app.enqueue();
  const result = await app.next();

  assert.equal(result.outcome, "completed");
  assert.equal(app.courses.length, 1);
  const doc = app.courses[0]!.doc;
  assert.deepEqual(plain(draftSchema.DraftDoc.parse(doc)), doc);
  assert.deepEqual(doc.meta, { title: "Wake turbulence", description: "Avoiding wake.", category: null, tags: [], scheduleKind: null, recurrenceMonths: null, requiresQuizPass: false });
  assert.deepEqual(doc.lessons.map((l: any) => [l.title, l.estMinutes]), [["Lesson 1", 11], ["Lesson 2", 12], ["Lesson 3", 13]]);
  doc.lessons.forEach((l: any, i: number) => {
    const n = i + 1;
    const strip = ({ key: _key, ...rest }: any) => rest;
    assert.deepEqual(l.blocks.slice(0, -1).map(strip), goodBlocks(n));
    assert.deepEqual(strip(l.blocks.at(-1)), { kind: "quiz", passingScore: 70, isExam: false, questions: quizFor(n) });
  });
  const keys = doc.lessons.flatMap((l: any) => [l.key, ...l.blocks.map((b: any) => b.key)]);
  assert.equal(new Set(keys).size, keys.length);

  assert.deepEqual(plain(result.course), {
    courseId: result.courseId, slug: "wake-turbulence", title: "Wake turbulence", lessonCount: 3, questionCount: 9, droppedBlocks: [],
  });
  const done = app.row(id);
  assert.deepEqual(
    [done.Status, done.Stage, done.LessonsDone, done.LessonsTotal, done.Attempts, done.ResultCourseId, done.WorkJson, done.LeaseToken, done.LeaseUntil],
    ["completed", "saving", 3, 3, 1, result.courseId, null, null, null],
  );
  assert.equal(app.courses[0]!.createdBy, BY);
  assert.equal(app.courses[0]!.status, "draft");
  const [service, status, , items, message, errorCount] = app.runs[0]!;
  assert.deepEqual([service, status, items, errorCount], ["lms-ai-authoring", "SUCCESS", 3, 0]);
  assert.equal(message, `youtube tenant=${TENANT} ingestion=${id} attempt=1 course=${result.courseId} questions=9 dropped=0 ${THREE_LESSON_TOKENS}`);
  assert.deepEqual(app.errors, []);
});

test("every statement but the claim names the job's tenant, every write after the claim carries its lease, and nothing publishes", async () => {
  const app = harness();
  await app.enqueue(OTHER_TENANT);
  app.clock.t += 1;
  const id = await app.enqueue();
  app.rows.find((r) => r.TenantId === OTHER_TENANT)!.NotBefore = START + minutes(60);
  const result = await app.next();
  assert.equal(result.outcome, "completed");
  assert.equal(result.ingestionId, id);

  const claim = app.statements.filter((s) => s.sql.startsWith("WITH next AS"));
  assert.equal(claim.length, 1);
  for (const { sql, params } of app.statements) {
    if (sql.startsWith("WITH next AS")) continue;
    assert.ok(params.tenantId === TENANT || params.tenantId === OTHER_TENANT, sql);
    assert.match(sql, /TenantId = @tenantId|VALUES \(@\w+, @tenantId/, sql);
    assert.doesNotMatch(sql, /CurrentVersionId|INSERT INTO lms\.(CourseVersion|Lesson|Block|Quiz|QuizQuestion) \(|UPDATE lms\.Course\b|\bpublish/i, sql);
  }
  const lease = claim[0]!.params.leaseToken;
  const afterClaim = app.statements.slice(app.statements.indexOf(claim[0]!) + 1);
  const writes = afterClaim.filter(({ sql }) => /^UPDATE lms\.AssetIngestion|^SET XACT_ABORT/.test(sql));
  assert.equal(writes.length, 8, "six stage writes, the course, the completion");
  for (const { sql, params } of afterClaim) assert.equal(params.tenantId, TENANT, sql);
  for (const { sql, params } of writes) {
    assert.equal(params.leaseToken, lease, sql);
    assert.match(sql, /IngestionId = @ingestionId AND TenantId = @tenantId AND LeaseToken = @leaseToken/, sql);
  }
  assert.equal(app.rows.find((r) => r.TenantId === OTHER_TENANT)!.Status, "queued");

  const source = readFileSync(new URL("./job.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /course-publish|publishDraft|publish\??:|CurrentVersionId|INSERT INTO|@\/lib\/db"/);
  const cli = readFileSync(new URL("../../../scripts/ingest-youtube.ts", import.meta.url), "utf8");
  assert.match(cli, /const input = ingestionInput\(args\.createdBy, await sourceInput\(args\.source\)\);/);
  assert.match(cli, /enqueueIngestion\(tenantId, input\)/);
  assert.match(cli, /--url <page-url>/);
  assert.match(cli, /--text-file <path> --title <title>/);
  assert.match(cli, /runIngestionInline\(tenantId, ingestionId, \{/);
  assert.doesNotMatch(cli, /--draft|authorCourseFromYouTube/);
});

test("a generated block the schemas refuse is left out and reported as a warning; the rest of the course is saved", async () => {
  const app = harness({ blocks: (n) => n === 2
    ? [text("Intro 2"), { kind: "image", url: "javascript:alert(1)", alt: "x" }, text("Body 2")]
    : goodBlocks(n) });
  const id = await app.enqueue();
  const result = await app.next();

  const dropped = { lesson: 2, position: 2, kind: "image", reason: "url: Enter a web address starting with https://, or a path on this site starting with /." };
  assert.deepEqual(plain(result.course.droppedBlocks), [dropped]);
  assert.deepEqual(JSON.parse(app.row(id).WarningsJson), [dropped]);
  const doc = app.courses[0]!.doc;
  assert.deepEqual(doc.lessons[1].blocks.map((b: any) => b.kind), ["text", "text", "quiz"]);
  assert.doesNotMatch(JSON.stringify(doc), /javascript:/);
  const [, status, , , message, errorCount] = app.runs[0]!;
  assert.equal(status, "PARTIAL");
  assert.equal(errorCount, 1);
  assert.match(String(message), /dropped=1 \(lesson 2 block 2 image: url: Enter a web address starting with https:\/\//);
});

test("a lesson left with fewer than two valid blocks fails the job at once: no course, no retry, the error logged", async () => {
  const app = harness({ blocks: (n) => n === 3 ? [text("Intro 3"), { kind: "video", url: "ftp://media.example.test/a.mp4" }] : goodBlocks(n) });
  const id = await app.enqueue();
  const result = await app.next();

  assert.equal(result.outcome, "failed");
  assert.match(result.error, /^Lesson 3 produced only 1 valid block\(s\) after filtering\. Refused: block 2 \(video\) url: Enter a web address starting with https:\/\/\.$/);
  assert.equal(app.courses.length, 0);
  const failed = app.row(id);
  assert.deepEqual([failed.Status, failed.Attempts, failed.LeaseToken], ["failed", 1, null]);
  assert.equal(failed.ErrorMessage, result.error);
  assert.equal(app.errors.length, 1);
  assert.deepEqual(app.runs.map((r) => [r[0], r[1], r[5]]), [["lms-ai-authoring", "FAILURE", 1]]);
  app.clock.t += minutes(60);
  assert.equal((await app.next()).outcome, "idle");
});

test("a course the draft refuses as a whole fails at once, naming where, before anything is created", async () => {
  const app = harness({ outline: () => ({ ...OUTLINE, description: "x".repeat(8001) }) });
  const id = await app.enqueue();
  const result = await app.next();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /doesn't fit a course draft at course description: /);
  assert.equal(app.courses.length, 0);
  assert.equal(app.row(id).Status, "failed");

  const big = { lesson: lesson(1), blocks: [{ kind: "text" as const, markdown: "a" }], quiz: { questions: Array(51).fill(quizFor(1)[1]) } };
  assert.throws(() => toAuthoredDraft(OUTLINE, [big]), (e: unknown) => e instanceof AuthoredDraftError && /at lesson 1 block 2 questions: /.test(e.message));
});

// ---- A2: the queue ---------------------------------------------------------

test("a transient model error requeues the job with a doubling backoff in NotBefore, and the fourth attempt fails it", async () => {
  const app = harness({ outline: () => { throw rateLimited(); } });
  const id = await app.enqueue();
  const delays: number[] = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await app.next();
    assert.equal(result.outcome, "requeued", `attempt ${attempt}`);
    assert.equal(result.attempts, attempt);
    delays.push(result.delaySeconds);
    const queued = app.row(id);
    assert.deepEqual([queued.Status, queued.Attempts, queued.LeaseToken, queued.Stage], ["queued", attempt, null, "outline"]);
    assert.equal(queued.NotBefore, app.clock.t + result.delaySeconds * 1000);
    assert.match(queued.ErrorMessage, /^429 /);
    app.clock.t += result.delaySeconds * 1000 - 1;
    assert.equal((await app.next()).outcome, "idle", "not before its delay");
    app.clock.t += 1;
  }
  assert.deepEqual(delays, [60, 120, 240]);

  const last = await app.next();
  assert.equal(last.outcome, "failed");
  assert.match(last.error, /^Gave up after 4 attempts: 429 /);
  const failed = app.row(id);
  assert.deepEqual([failed.Status, failed.Attempts], ["failed", 4]);
  assert.equal(app.calls.extract, 1, "the extract is kept, not fetched again");
  assert.equal(app.calls.outline, 4);
  assert.equal(app.courses.length, 0);
  assert.deepEqual(app.errors.map((e) => e[2]), ["WARNING", "WARNING", "WARNING", "ERROR"]);
  assert.deepEqual(app.runs.map((r) => r[1]), ["FAILURE"]);
});

test("the server's retry-after hint stretches the backoff, capped at fifteen minutes; a refusal or a dropped answer is told apart", async () => {
  const hinted = harness({ outline: () => { throw rateLimited({ "retry-after": "300" }); } });
  await hinted.enqueue();
  assert.equal((await hinted.next()).delaySeconds, 300);
  const job = hinted.job;
  assert.equal(job.backoffSeconds(1, null), 60);
  assert.equal(job.backoffSeconds(4, null), 480);
  assert.equal(job.backoffSeconds(9, null), 900);
  assert.equal(job.backoffSeconds(1, 3_600_000), 900);
  assert.equal(job.backoffSeconds(2, 1500), 120);

  assert.ok(claude.transientAiError(overloaded()));
  assert.ok(claude.transientAiError(new Anthropic.APIConnectionTimeoutError()));
  assert.ok(claude.transientAiError(new Anthropic.APIError(408, undefined, "timeout", {})));
  assert.deepEqual(claude.transientAiError(rateLimited({ "retry-after-ms": "2500" })), { retryAfterMs: 2500 });
  assert.equal(claude.transientAiError(refused()), null);
  assert.equal(claude.transientAiError(new Anthropic.APIUserAbortError()), null);
  assert.equal(claude.transientAiError(new Error("Request timed out")), null);

  const bad = harness({ outline: () => { throw refused(); } });
  const id = await bad.enqueue();
  const result = await bad.next();
  assert.equal(result.outcome, "failed");
  assert.deepEqual([bad.row(id).Status, bad.row(id).Attempts], ["failed", 1]);
});

test("the lessons stage runs the lessons not yet in the work and keeps each as it finishes, so a retry pays only for the one that failed", async () => {
  const app = harness({ blocks: (n, call) => {
    if (n === 2 && call === 1) throw overloaded();
    return goodBlocks(n);
  } });
  const id = await app.enqueue();
  const progress: unknown[] = [];
  const first = await app.next({ onProgress: (p: unknown) => progress.push(plain(p)) });
  assert.equal(first.outcome, "requeued");
  const kept = JSON.parse(app.row(id).WorkJson);
  assert.deepEqual(kept.lessons.map((l: unknown) => l !== null), [true, false, true]);
  assert.equal(kept.extract.kind, "youtube");
  assert.equal(kept.extract.text, "the transcript");
  assert.deepEqual([app.row(id).Stage, app.row(id).LessonsDone, app.row(id).LessonsTotal], ["lessons", 2, 3]);
  assert.deepEqual(progress.map((p: any) => p.stage), ["outline", "lessons", "lessons", "lessons"]);
  assert.deepEqual(plain(progress.at(-1)), { ingestionId: id, stage: "lessons", lessonsDone: 2, lessonsTotal: 3 });

  app.clock.t += first.delaySeconds * 1000;
  const second = await app.next();
  assert.equal(second.outcome, "completed");
  assert.equal(app.calls.extract, 1);
  assert.equal(app.calls.outline, 1);
  assert.deepEqual([...app.calls.blocks].sort(), [1, 2, 2, 3]);
  assert.deepEqual([...app.calls.quiz].sort(), [1, 2, 2, 3]);
  assert.equal(app.courses.length, 1);
  assert.equal(app.courses[0]!.doc.lessons.length, 3);
});

test("a refusal fails the job even when another lesson in the same stage only hit a rate limit", async () => {
  const app = harness({ blocks: (n) => {
    if (n === 1) throw rateLimited();
    if (n === 2) return [text("only one")];
    return goodBlocks(n);
  } });
  const id = await app.enqueue();
  const result = await app.next();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /^Lesson 2 produced only 1 valid block/);
  assert.equal(app.row(id).Status, "failed");
});

test("out of stage budget, the job is paused, due again at once with its attempt given back, and the next call carries on", async () => {
  const app = harness({ onExtract: () => { app.clock.t += 150_000; } });
  const id = await app.enqueue();
  const first = await app.next({ budgetMs: 100_000 });
  assert.deepEqual(plain(first), { outcome: "paused", ingestionId: id, stage: "outline" });
  const paused = app.row(id);
  assert.deepEqual([paused.Status, paused.Attempts, paused.Stage, paused.LeaseToken, paused.NotBefore], ["queued", 0, "outline", null, app.clock.t]);
  assert.equal(app.calls.outline, 0);

  const second = await app.next({ budgetMs: 100_000 });
  assert.equal(second.outcome, "completed");
  assert.equal(app.calls.extract, 1);
  assert.equal(app.row(id).Attempts, 1);
});

test("a worker whose lease ran out and was taken can't write: its stage write, its course and its failure all stop", async () => {
  const app = harness();
  const id = await app.enqueue();
  const stale = await app.ingestions.claimNextIngestion();
  app.clock.t += 601_000;
  const fresh = await app.ingestions.claimNextIngestion();
  assert.equal(fresh.ingestionId, id);
  assert.notEqual(fresh.leaseToken, stale.leaseToken);
  const before = { ...app.row(id) };

  const lost = await app.job.runIngestion(stale, { now: app.now });
  assert.deepEqual(plain(lost), { outcome: "lease_lost", ingestionId: id });
  assert.deepEqual(app.row(id), before, "the stale worker changed nothing");
  assert.equal(app.calls.extract, 1, "it stopped at its first write");
  assert.equal(app.courses.length, 0);
  assert.equal(await app.ingestions.failIngestion(stale, "x"), false);
  assert.equal(await app.ingestions.requeueIngestion(stale, 60, "x"), false);
  assert.equal(await app.ingestions.pauseIngestion(stale), false);
  assert.equal(await app.ingestions.completeIngestion(stale), false);
  assert.deepEqual(app.row(id), before);

  // With every stage already in the work, the stale worker's next write is
  // createCourse itself: refused in the same statement, no course.
  const done = await app.job.runIngestion(fresh, { now: app.now });
  assert.equal(done.outcome, "completed");
  const app2 = harness();
  const id2 = await app2.enqueue();
  const holder = await app2.ingestions.claimNextIngestion();
  await app2.job.runIngestion(holder, { now: app2.now, budgetMs: 0 });
  app2.row(id2).WorkJson = JSON.stringify({
    extract: { videoId: "x", url: URL_IN, title: "Video", author: "A", thumbnailUrl: "", transcript: "t", durationApproxSec: 60, transcriptSource: "yt-dlp" },
    outline: OUTLINE,
    lessons: [1, 2, 3].map((n) => ({ blocks: goodBlocks(n), dropped: [], quiz: { questions: quizFor(n) } })),
  });
  const staleSaver = await app2.ingestions.claimNextIngestion();
  app2.clock.t += 601_000;
  await app2.ingestions.claimNextIngestion();
  const refusedCourse = await app2.job.runIngestion(staleSaver, { now: app2.now });
  assert.equal(refusedCourse.outcome, "lease_lost");
  assert.equal(app2.courses.length, 0);
  assert.equal(app2.row(id2).Status, "running");
  assert.equal(app2.calls.blocks.length, 0, "the work it found was used, not paid for again");
});

test("a retry after the course was made but the job not marked complete finishes the job and makes no second course", async () => {
  const app = harness();
  const id = await app.enqueue();
  let failComplete = true;
  app.faults.before = (sql) => (failComplete && /^UPDATE lms\.AssetIngestion SET Status = 'completed'/.test(sql) ? new Error("Connection lost") : undefined);
  const first = await app.next();
  assert.equal(first.outcome, "interrupted");
  assert.equal(app.courses.length, 1);
  const courseId = app.courses[0]!.courseId;
  assert.equal(first.courseId, courseId);
  assert.deepEqual([app.row(id).Status, app.row(id).ResultCourseId], ["running", courseId]);
  assert.match(String(app.errors.at(-1)![1]), /not marked complete: Connection lost$/);

  failComplete = false;
  assert.equal((await app.next()).outcome, "idle", "the lease still holds it");
  app.clock.t += 601_000;
  const retry = await app.next();
  assert.deepEqual(plain(retry), { outcome: "completed", ingestionId: id, courseId, course: null });
  assert.equal(app.courses.length, 1);
  assert.deepEqual([app.row(id).Status, app.row(id).Attempts, app.row(id).WorkJson], ["completed", 2, null]);
  assert.equal(app.calls.outline, 1);
  assert.equal(app.calls.blocks.length, 3);
});

test("a course whose commit landed but whose answer was lost is never failed or made twice", async () => {
  const app = harness();
  const id = await app.enqueue();
  let lose = true;
  app.faults.after = (sql) => (lose && sql.startsWith("SET XACT_ABORT ON") ? Object.assign(new Error("socket hang up"), { code: "ESOCKET" }) : undefined);
  const first = await app.next();
  assert.equal(first.outcome, "lease_lost");
  assert.equal(app.courses.length, 1);
  assert.deepEqual([app.row(id).Status, app.row(id).ResultCourseId], ["running", app.courses[0]!.courseId]);

  lose = false;
  app.clock.t += 601_000;
  const retry = await app.next();
  assert.equal(retry.outcome, "completed");
  assert.equal(retry.courseId, app.courses[0]!.courseId);
  assert.equal(app.courses.length, 1);
  assert.equal(app.row(id).Status, "completed");
});

test("a job whose worker keeps dying is failed on its fifth claim instead of running forever", async () => {
  const app = harness();
  const id = await app.enqueue();
  Object.assign(app.row(id), { Status: "running", Attempts: 4, LeaseToken: crypto.randomUUID(), LeaseUntil: START - 1 });
  const result = await app.next();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /^Stopped after 4 attempts/);
  assert.equal(app.calls.extract, 0);
});

test("a job that already has its course is finished however many claims it took, never left running", async () => {
  const app = harness();
  const id = await app.enqueue();
  const courseId = crypto.randomUUID();
  Object.assign(app.row(id), { Status: "running", Attempts: 7, LeaseToken: crypto.randomUUID(), LeaseUntil: START - 1, ResultCourseId: courseId });
  const result = await app.next();
  assert.deepEqual(plain(result), { outcome: "completed", ingestionId: id, courseId, course: null });
  assert.equal(app.row(id).Status, "completed");
  assert.equal(app.calls.extract, 0);
});

test("the CLI's inline run claims its own job, waits out a retry delay and returns the finished job", async () => {
  const app = harness({ outline: (call) => { if (call === 1) throw rateLimited(); return OUTLINE; } });
  const id = await app.enqueue();
  await app.enqueue(OTHER_TENANT);
  const waits: number[] = [];
  const { ingestion, course } = await app.job.runIngestionInline(TENANT, id, {
    now: app.now,
    sleep: async (ms: number) => { app.clock.t += ms; },
    onWait: (_job: unknown, ms: number) => waits.push(ms),
  });
  assert.deepEqual(waits, [60_000]);
  assert.equal(ingestion.status, "completed");
  assert.equal(ingestion.courseId, course.courseId);
  assert.equal(ingestion.attempts, 2);
  assert.equal(app.courses.length, 1);
  assert.equal(app.rows.find((r) => r.TenantId === OTHER_TENANT)!.Status, "queued", "another tenant's job is left alone");
  await assert.rejects(app.job.runIngestionInline(OTHER_TENANT, id, { now: app.now, sleep: async () => undefined }), /not found for this tenant/);
});

// ---- token usage -----------------------------------------------------------

const callsIn = (json: string) => Object.values(JSON.parse(json) as Record<string, { calls: number }>).reduce((n, m) => n + m.calls, 0);

test("a completed job records every model call's tokens per model in UsageJson: the outline, then each lesson's blocks and quiz", async () => {
  const app = harness();
  const id = await app.enqueue();
  const result = await app.next();
  assert.equal(result.outcome, "completed");

  assert.deepEqual(JSON.parse(app.row(id).UsageJson), THREE_LESSONS);
  assert.deepEqual(plain((await app.ingestions.getIngestion(TENANT, id)).usage), THREE_LESSONS);
  const writes = app.statements.filter(({ sql }) => sql.startsWith("UPDATE lms.AssetIngestion SET"));
  assert.equal(writes.length, 7, "six stage writes and the completion");
  for (const { sql } of writes) assert.match(sql, /UsageJson = @usage/, sql);
  const running = writes.map(({ params }) => callsIn(params.usage));
  assert.deepEqual(running.slice(0, 2), [0, 1], "nothing after the extract, the outline after the outline");
  assert.equal(running.at(-1), 7);
  running.forEach((n, i) => assert.ok(i === 0 || n >= running[i - 1]!, `running total ${running.join(",")}`));
  assert.match(String(app.runs[0]![4]), new RegExp(` ${THREE_LESSON_TOKENS}$`));
});

test("a job requeued after a 429 in one lesson keeps what the calls that answered spent, and the retry adds only its own calls", async () => {
  let slowQuiz = true;
  const app = harness({
    blocks: (n, call) => {
      if (n === 2 && call === 1) throw rateLimited();
      return goodBlocks(n);
    },
    // Lesson 2's quiz answers after its blocks call has already failed.
    onQuiz: async (n) => {
      if (n === 2 && slowQuiz) {
        slowQuiz = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  });
  const id = await app.enqueue();
  const first = await app.next();
  assert.equal(first.outcome, "requeued");
  const afterFirst = {
    "bulk-model": { calls: 4, inputTokens: 1150, outputTokens: 1100, cacheWriteTokens: 5000, cacheReadTokens: 15000 },
    "reasoning-model": { calls: 2, inputTokens: 200, outputTokens: 4000, cacheWriteTokens: 0, cacheReadTokens: 10000 },
  };
  assert.deepEqual(JSON.parse(app.row(id).UsageJson), afterFirst, "lesson 2's quiz counts though its lesson failed");
  const requeue = app.statements.filter(({ sql }) => sql.startsWith("UPDATE lms.AssetIngestion SET Status = 'queued'"));
  assert.equal(requeue.length, 1);
  assert.deepEqual(JSON.parse(requeue[0]!.params.usage), afterFirst);

  app.clock.t += first.delaySeconds * 1000;
  const second = await app.next();
  assert.equal(second.outcome, "completed");
  assert.deepEqual([app.calls.outline, app.calls.quiz.length, app.calls.blocks.length], [1, 4, 4], "one outline, four quizzes, four blocks calls of which the rate-limited one spent nothing");
  assert.deepEqual(JSON.parse(app.row(id).UsageJson), {
    "bulk-model": { calls: 5, inputTokens: 1200, outputTokens: 1400, cacheWriteTokens: 5000, cacheReadTokens: 20000 },
    "reasoning-model": { calls: 3, inputTokens: 300, outputTokens: 6000, cacheWriteTokens: 0, cacheReadTokens: 15000 },
  });
  assert.match(String(app.runs.at(-1)![4]), / tokens in=41500 out=7400$/);
});

test("output the job can't use still counts what it cost, and the failure's run log carries the total", async () => {
  const refusedLesson = harness({ blocks: (n) => n === 3 ? [text("Intro 3"), { kind: "video", url: "ftp://media.example.test/a.mp4" }] : goodBlocks(n) });
  const id = await refusedLesson.enqueue();
  assert.equal((await refusedLesson.next()).outcome, "failed");
  assert.deepEqual(JSON.parse(refusedLesson.row(id).UsageJson), THREE_LESSONS, "lesson 3's refused blocks call counts");
  const [, status, , , message] = refusedLesson.runs[0]!;
  assert.equal(status, "FAILURE");
  assert.match(String(message), new RegExp(`^youtube tenant=${TENANT} ingestion=${id} attempt=1: Lesson 3 produced only 1 valid block.* ${THREE_LESSON_TOKENS}$`));

  const cutOff = harness({ outline: () => { throw new usageModule.ModelOutputError("Tool call to 'submit_outline' hit max_tokens (4096).", OUTLINE_USAGE); } });
  const id2 = await cutOff.enqueue();
  assert.equal((await cutOff.next()).outcome, "failed");
  assert.deepEqual(JSON.parse(cutOff.row(id2).UsageJson), {
    "bulk-model": { calls: 1, inputTokens: 1000, outputTokens: 200, cacheWriteTokens: 5000, cacheReadTokens: 0 },
  });
  assert.match(String(cutOff.runs[0]![4]), / tokens in=6000 out=200$/);
});

test("a retry that only finishes the job counts no call twice", async () => {
  const app = harness();
  const id = await app.enqueue();
  let failComplete = true;
  app.faults.before = (sql) => (failComplete && /^UPDATE lms\.AssetIngestion SET Status = 'completed'/.test(sql) ? new Error("Connection lost") : undefined);
  assert.equal((await app.next()).outcome, "interrupted");
  assert.deepEqual(JSON.parse(app.row(id).UsageJson), THREE_LESSONS);

  failComplete = false;
  app.clock.t += 601_000;
  assert.equal((await app.next()).outcome, "completed");
  assert.deepEqual(JSON.parse(app.row(id).UsageJson), THREE_LESSONS);
  assert.match(String(app.runs.at(-1)![4]), new RegExp(` ${THREE_LESSON_TOKENS}$`));
});

// ---- A3: pasted text and web pages as sources ----------------------------------

const embedAsked = (prompt: string) => /embed the source video|embed block with url|source video embed/i.test(prompt);
const noEmbed = (n: number) => goodBlocks(n).filter((b) => b.kind !== "embed");

test("a pasted text job reads the paste from its options, names it in the corpus, asks for no embed, and never shows the text in the status", async () => {
  const app = harness({ blocks: noEmbed });
  const id = await app.enqueueSource({ kind: "text", ...PASTE, title: "  Hangar\n notes " });
  const queued = app.row(id);
  assert.deepEqual([queued.SourceKind, queued.SourceRef], ["text", "Hangar notes"]);
  assert.deepEqual(JSON.parse(queued.OptionsJson), { source: PASTE });

  const result = await app.next();
  assert.equal(result.outcome, "completed");
  assert.deepEqual(app.calls.extracts, [{ kind: "text", title: "Hangar notes", author: null, url: null, text: PASTE.text, approxMinutes: 1 }]);
  assert.deepEqual([app.calls.extract, app.web.lookups, app.web.connections], [0, [], []]);
  assert.equal(app.calls.blockPrompts.length, 3);
  for (const prompt of app.calls.blockPrompts) {
    assert.ok(prompt.includes('Source: pasted text "Hangar notes"\nLength: ~1 minutes of reading\n\nTEXT:\nChock the wheels.'));
    assert.ok(!embedAsked(prompt), prompt.slice(0, 200));
  }
  assert.deepEqual(app.courses[0]!.doc.lessons.map((l: any) => l.blocks.some((b: any) => b.kind === "embed")), [false, false, false]);

  const status = await app.ingestions.getIngestion(TENANT, id);
  assert.equal(status.status, "completed");
  assert.equal(status.sourceRef, "Hangar notes");
  assert.ok(!JSON.stringify(status).includes("Chock the wheels"));
  assert.ok(!JSON.stringify([app.runs, app.errors]).includes("Chock the wheels"), "the paste is never logged");
});

test("a web page job fetches the page through the guarded fetch, reads its text and title, and asks for no embed", async () => {
  const app = harness({ blocks: noEmbed });
  const id = await app.enqueueSource({ kind: "url", url: ` ${PAGE_URL}#top ` });
  assert.deepEqual([app.row(id).SourceKind, app.row(id).SourceRef], ["url", PAGE_URL]);

  const result = await app.next();
  assert.equal(result.outcome, "completed");
  assert.deepEqual(app.calls.extracts, [{
    kind: "url", title: "Wake turbulence & you", author: "aviation.example", url: PAGE_URL,
    text: "Wake\nVortices trail from wingtips.", approxMinutes: 1,
  }]);
  assert.deepEqual(app.web.connections, [{ host: "aviation.example", address: "93.184.215.14", url: PAGE_URL }]);
  assert.equal(app.calls.extract, 0);
  for (const prompt of app.calls.blockPrompts) {
    assert.ok(prompt.includes(`Source: web page "Wake turbulence & you" from aviation.example\nURL: ${PAGE_URL}\nLength: ~1 minutes of reading\n\nPAGE TEXT:\nWake\nVortices`));
    assert.ok(!embedAsked(prompt));
    assert.ok(!prompt.includes("steal()"), "scripts are dropped");
  }
});

test("a page whose host resolves to a private address fails at once: no connection, no retry, no model call", async () => {
  const app = harness();
  const id = await app.enqueueSource({ kind: "url", url: "https://intranet.example/wiki" });
  const result = await app.next();
  assert.equal(result.outcome, "failed");
  assert.match(result.error, /^intranet\.example resolves to a private address; only public addresses can be fetched\.$/);
  assert.deepEqual([app.row(id).Status, app.row(id).Attempts, app.row(id).ErrorMessage], ["failed", 1, result.error]);
  assert.deepEqual([app.web.lookups, app.web.connections], [["intranet.example"], []]);
  assert.equal(app.calls.outline, 0);
  assert.equal(await app.next().then((r: any) => r.outcome), "idle");
});

test("an address that gives itself away is refused before anything is queued", () => {
  const app = harness();
  for (const [url, pattern] of [
    ["http://169.254.169.254/latest/meta-data/", /The web address is a cloud metadata address/],
    ["http://[::ffff:127.0.0.1]/admin", /The web address is a loopback address/],
    ["http://10.0.0.7/", /The web address is a private address/],
    ["ftp://aviation.example/notes.txt", /Only http and https addresses can be fetched, not ftp/],
    ["https://aviation.example:8443/", /Only ports 80 and 443 can be fetched, not 8443/],
    ["https://user:pw@aviation.example/", /user name or password/],
    [`https://aviation.example/${"a".repeat(2048)}`, /The web address is 2,0\d\d characters; the most is 2,048/],
  ] as const) {
    assert.throws(() => app.job.ingestionInput(BY, { kind: "url", url }), (err: unknown) => err instanceof source.SourceRefusedError && pattern.test(err.message), url);
  }
  assert.throws(() => app.job.ingestionInput(BY, { kind: "youtube", url: PAGE_URL }), /not a YouTube video address/);
  assert.equal(app.rows.length, 0);
});

test("a page that answers 503 requeues the job under the page's retry-after, and the next attempt completes", async () => {
  const app = harness({ blocks: noEmbed, pages: { [PAGE_URL]: (hit): FakeReply => hit === 1
    ? { status: 503, headers: { "retry-after": "240" } }
    : { headers: { "content-type": "text/html" }, body: PAGE_HTML } } });
  const id = await app.enqueueSource({ kind: "url", url: PAGE_URL });
  const first = await app.next();
  assert.deepEqual([first.outcome, first.delaySeconds, first.error], ["requeued", 240, "The page answered 503."]);
  assert.deepEqual([app.row(id).Status, app.row(id).Stage, app.row(id).NotBefore], ["queued", null, START + 240_000]);
  assert.equal(app.calls.outline, 0);

  app.clock.t += 240_000;
  const second = await app.next();
  assert.equal(second.outcome, "completed");
  assert.equal(app.web.hits.get(PAGE_URL), 2);
  assert.equal(app.row(id).Attempts, 2);
});

test("a page that keeps failing with 404 or the wrong type is refused at once, not retried", async () => {
  for (const [page, pattern] of [
    [{ status: 404, headers: { "content-type": "text/html" }, body: "gone" }, /^The page answered 404\.$/],
    [{ headers: { "content-type": "application/pdf" }, body: "%PDF" }, /^The page is application\/pdf; only text\/html or text\/plain can be read\.$/],
    [{ headers: { "content-type": "text/html" }, body: "<script>only()</script>" }, /^The page has no readable text\.$/],
  ] as const) {
    const app = harness({ pages: { [PAGE_URL]: page } });
    const id = await app.enqueueSource({ kind: "url", url: PAGE_URL });
    const result = await app.next();
    assert.equal(result.outcome, "failed");
    assert.match(result.error, pattern);
    assert.deepEqual([app.row(id).Status, app.row(id).Attempts, app.web.hits.get(PAGE_URL)], ["failed", 1, 1]);
  }
});

test("a YouTube address given as a web page becomes a YouTube job, and a page job naming a video still reads the video", async () => {
  const app = harness();
  const id = await app.enqueueSource({ kind: "url", url: "https://www.youtube.com/watch?v=abc123" });
  assert.deepEqual([app.row(id).SourceKind, app.row(id).SourceRef], ["youtube", "https://www.youtube.com/watch?v=abc123"]);
  assert.equal((await app.next()).outcome, "completed");
  assert.equal(app.calls.extract, 1);
  assert.equal(app.calls.extracts[0].kind, "youtube");

  const legacy = harness();
  await legacy.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "url", sourceRef: "https://youtu.be/abc123", options: {} });
  assert.equal((await legacy.next()).outcome, "completed");
  assert.deepEqual([legacy.calls.extract, legacy.web.connections], [1, []]);
  assert.ok(legacy.calls.blockPrompts.some((p) => p.includes('This is lesson 1 — include exactly ONE embed block with url="https://youtu.be/abc123"')));
});

test("a job of a kind this worker doesn't read, such as pdf, fails at once without reading anything", async () => {
  const app = harness();
  const id = await app.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "pdf", sourceRef: "manual.pdf", options: {} });
  const result = await app.next();
  assert.deepEqual([result.outcome, result.error], ["failed", "Unsupported source kind 'pdf'."]);
  assert.deepEqual([app.row(id).Status, app.row(id).Attempts, app.calls.extract, app.web.lookups.length, app.calls.outline], ["failed", 1, 0, 0, 0]);
  assert.throws(() => app.job.ingestionInput(BY, { kind: "pdf", url: "https://aviation.example/m.pdf" }), /Unsupported source kind 'pdf'\.$/, "an unknown input kind is never queued as a page");
  assert.throws(() => app.job.ingestionInput(BY, { kind: "url" }), /The source needs a web address\.$/);
});

test("a paste over 200,000 characters, an empty one or one without a title is refused before it is queued; exactly the cap is accepted", () => {
  const app = harness();
  const MAX = source.SOURCE_TEXT_MAX;
  const refusedWith = (input: unknown, pattern: RegExp) =>
    assert.throws(() => app.job.ingestionInput(BY, input), (err: unknown) => err instanceof source.SourceRefusedError && pattern.test(err.message));
  refusedWith({ kind: "text", title: "Big", text: "a".repeat(MAX + 1) }, /^The pasted text is 200,001 characters; the most is 200,000\.$/);
  refusedWith({ kind: "text", title: "Blank", text: " \n\t " }, /^The pasted text is empty\.$/);
  refusedWith({ kind: "text", title: "  ", text: "words" }, /^Pasted text needs a title\.$/);
  refusedWith({ kind: "text", title: "t".repeat(201), text: "words" }, /^The title is 201 characters; the most is 200\.$/);
  assert.equal(app.rows.length, 0);
  const full = app.job.ingestionInput(BY, { kind: "text", title: "Full", text: "a".repeat(MAX) });
  assert.equal(full.options.source.text.length, MAX);
});

test("a text job with no paste in its options, or a paste over the cap put there directly, fails at once", async () => {
  for (const options of [{}, { source: "words" }, { source: { title: "Big", text: "a".repeat(source.SOURCE_TEXT_MAX + 1) } }]) {
    const app = harness();
    const id = await app.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "text", sourceRef: "Notes", options });
    const result = await app.next();
    assert.equal(result.outcome, "failed");
    assert.match(result.error, /^(The job holds no pasted text|The pasted text is 200,001 characters)/);
    assert.deepEqual([app.row(id).Status, app.row(id).Attempts, app.calls.outline], ["failed", 1, 0]);
  }
});

// ---- A4: the author's options reach the prompts -------------------------------

test("the author's lesson count reaches the outline call, and a job with no options asks for none", async () => {
  const app = harness({ outline: () => ({ ...OUTLINE, lessons: [lesson(1), lesson(2), lesson(3), lesson(4), lesson(5)] }) });
  const id = await app.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "youtube", sourceRef: URL_IN, options: { lessonCount: 5 } });
  const result = await app.next();
  assert.equal(result.outcome, "completed");
  assert.equal(result.ingestionId, id);
  assert.deepEqual(app.calls.outlineOptions, [{ lessonCount: 5 }]);
  assert.equal(app.courses[0]!.doc.lessons.length, 5);

  for (const optionsJson of [null, "{}", "not json", JSON.stringify({ lessonCount: 2 }), JSON.stringify({ lessonCount: 11 }), JSON.stringify({ lessonCount: "5" })]) {
    const legacy = harness();
    const legacyId = await legacy.enqueue();
    legacy.row(legacyId).OptionsJson = optionsJson;
    assert.equal((await legacy.next()).outcome, "completed", String(optionsJson));
    assert.deepEqual(legacy.calls.outlineOptions, [{ lessonCount: null }], String(optionsJson));
    assert.deepEqual(legacy.calls.quiz, [1, 2, 3], String(optionsJson));
  }
});

test("with quizzes off no quiz call is made and the draft has no quiz blocks; with them on every lesson ends in one", async () => {
  const off = harness();
  await off.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "youtube", sourceRef: URL_IN, options: { quizzes: false } });
  const result = await off.next();
  assert.equal(result.outcome, "completed");
  assert.deepEqual([off.calls.quiz, off.calls.blocks.length], [[], 3]);
  const doc = off.courses[0]!.doc;
  assert.deepEqual(plain(draftSchema.DraftDoc.parse(doc)), doc);
  for (const l of doc.lessons) assert.ok(l.blocks.length > 0 && l.blocks.every((b: any) => b.kind !== "quiz"), l.title);
  assert.equal(result.course.questionCount, 0);
  assert.match(String(off.runs[0]![4]), / questions=0 /);
  const spent = JSON.parse(off.row(result.ingestionId).UsageJson);
  assert.equal(spent["bulk-model"].calls, 1, "only the outline");

  const on = harness();
  await on.ingestions.enqueueIngestion(TENANT, { createdBy: BY, sourceKind: "youtube", sourceRef: URL_IN, options: { quizzes: true } });
  assert.equal((await on.next()).outcome, "completed");
  assert.deepEqual(on.calls.quiz, [1, 2, 3]);
  assert.deepEqual(on.courses[0]!.doc.lessons.map((l: any) => l.blocks.at(-1).kind), ["quiz", "quiz", "quiz"]);
});
