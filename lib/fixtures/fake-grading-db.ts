import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as claude from "@/lib/ai/claude";
import * as usage from "@/lib/ai/authoring/usage";
import * as deadlock from "@/lib/db/deadlock";
import * as chain from "@/lib/records/chain";
import * as quizSchema from "@/lib/schema/quiz";
import type { QuizQuestion } from "@/lib/schema/quiz";

// An in-memory database for the AI marking tests (slices A5a and A5b):
// lms.Learner, Quiz, QuizQuestion, QuizAttempt, AnswerResponse, AnswerGrade,
// AnswerGradingJob, AnswerReviewRequest, TenantAiSetting and AuditEvent. Each
// statement is matched by its shape, and every WHERE it carries is read from
// the statement's own text, so a tenant filter missing from the SQL is missing
// here too. The migrations' CHECK, UNIQUE and FOREIGN KEY rules on
// AnswerGrade, AnswerGradingJob and AnswerReviewRequest are enforced, and a
// batch that breaks one changes nothing.

type Row = Record<string, any>;
type Params = Record<string, any>;

export interface Statement {
  sql: string;
  params: Params;
}

export function vmLoad(file: URL, modules: Record<string, unknown>, globals: Record<string, unknown> = {}): any {
  const code = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports: any = {};
  runInNewContext(code, {
    exports, Error, Promise, JSON, String, Number, Math, Date, RegExp, Response, Request, URL, Set, Map, setTimeout,
    process: { env: {} }, ...globals,
    require: (id: string) => {
      if (!(id in modules)) throw new Error(`unexpected import ${id}`);
      return modules[id];
    },
  });
  return exports;
}

export const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const same = (a: unknown, b: unknown) =>
  a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();
const upper = (id: string | null) => (id === null ? null : id.toUpperCase());

function splitTop(list: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    if (list[i] === "(") depth++;
    else if (list[i] === ")") depth--;
    else if (depth === 0 && list.startsWith(separator, i)) {
      parts.push(list.slice(start, i).trim());
      start = i + separator.length;
      i += separator.length - 1;
    }
  }
  parts.push(list.slice(start).trim());
  return parts.filter(Boolean);
}

function column(row: Row, name: string): unknown {
  if (name in row) return row[name];
  const bare = name.includes(".") ? name.slice(name.indexOf(".") + 1) : name;
  if (bare in row) return row[bare];
  throw new Error(`no column ${name}`);
}

export interface FakeGradingDb {
  clock: { t: number };
  learners: { learnerId: string; tenantId: string; displayName: string; email: string }[];
  quizzes: { quizId: string; passingScore: number; courseTitle: string; lessonTitle: string }[];
  questions: { questionId: string; quizId: string; orderIndex: number; payload: QuizQuestion }[];
  attempts: { attemptId: string; quizId: string; learnerId: string; score: number | null; submittedAt: number }[];
  responses: { attemptId: string; questionId: string; responseJson: string; machineScore: number | null }[];
  grades: Row[];
  jobs: Row[];
  reviews: Row[];
  settings: Row[];
  audit: Row[];
  statements: Statement[];
  faults: { before?: (sql: string) => Error | undefined };
  module: { query: (sql: string, p?: Params) => Promise<unknown[]>; queryOne: (sql: string, p?: Params) => Promise<unknown>; execute: (sql: string, p?: Params) => Promise<number> };
}

export function fakeGradingDb(start = Date.UTC(2026, 9, 29, 12)): FakeGradingDb {
  const db: FakeGradingDb = {
    clock: { t: start },
    learners: [], quizzes: [], questions: [], attempts: [], responses: [], grades: [], jobs: [], reviews: [], settings: [], audit: [],
    statements: [],
    faults: {},
    module: {
      query: async (sql, p = {}) => run(sql, p).rows,
      queryOne: async (sql, p = {}) => run(sql, p).rows[0] ?? null,
      execute: async (sql, p = {}) => run(sql, p).count,
    },
  };

  const matches = (where: string, p: Params, row: Row): boolean =>
    splitTop(where, " AND ").every((part): boolean => {
      let m: RegExpExecArray | null;
      if ((m = /^([\w.]+) = @(\w+)$/.exec(part))) {
        if (!(m[2]! in p)) throw new Error(`no parameter @${m[2]}`);
        return same(column(row, m[1]!), p[m[2]!]);
      }
      if ((m = /^([\w.]+) = '(\w+)'$/.exec(part))) return column(row, m[1]!) === m[2];
      if ((m = /^([\w.]+) IS NULL$/.exec(part))) return column(row, m[1]!) === null;
      if ((m = /^([\w.]+) IS NOT NULL$/.exec(part))) return column(row, m[1]!) !== null;
      if (part === "((Status = 'queued' AND NotBefore <= SYSUTCDATETIME()) OR (Status = 'running' AND LeaseUntil < SYSUTCDATETIME()))") {
        return (row.Status === "queued" && row.NotBefore <= db.clock.t)
          || (row.Status === "running" && row.LeaseUntil !== null && row.LeaseUntil < db.clock.t);
      }
      if ((m = /^([\w.]+) NOT IN \((.*)\)$/.exec(part))) {
        const have = column(row, m[1]!);
        return have !== null && !splitTop(m[2]!).some((item) => have === value(item, p, row));
      }
      if (part.startsWith("(") && part.endsWith(")") && splitTop(part.slice(1, -1), " OR ").length > 1) {
        return splitTop(part.slice(1, -1), " OR ").some((either): boolean => matches(either, p, row));
      }
      throw new Error(`the fake database can't read the condition: ${part}`);
    });

  const value = (expr: string, p: Params, row: Row = {}) => {
    let m: RegExpExecArray | null;
    if (expr === "NULL") return null;
    if (expr === "SYSUTCDATETIME()") return db.clock.t;
    if ((m = /^@(\w+)$/.exec(expr))) {
      if (!(m[1]! in p)) throw new Error(`no parameter @${m[1]}`);
      return p[m[1]!] ?? null;
    }
    if ((m = /^@(\w+) \+ 1$/.exec(expr))) return Number(p[m[1]!]) + 1;
    if ((m = /^N?'([^']*)'$/.exec(expr))) return m[1];
    if ((m = /^DATEADD\(second, @(\w+), SYSUTCDATETIME\(\)\)$/.exec(expr))) return db.clock.t + Number(p[m[1]!]) * 1000;
    if ((m = /^(\w+) \+ 1$/.exec(expr))) return row[m[1]!] + 1;
    throw new Error(`the fake database can't evaluate: ${expr}`);
  };

  const assign = (set: string, p: Params, row: Row) => {
    const next = Object.fromEntries(splitTop(set).map((item) => {
      const m = /^(\w+) = (.+)$/.exec(item);
      if (!m) throw new Error(`the fake database can't read the assignment: ${item}`);
      return [m[1]!, value(m[2]!, p, row)];
    }));
    Object.assign(row, next);
  };

  const attemptRows = () => db.attempts.map((a) => {
    const learner = db.learners.find((l) => same(l.learnerId, a.learnerId));
    return {
      a,
      row: {
        "a.AttemptId": a.attemptId, "a.LearnerId": a.learnerId,
        "l.LearnerId": learner?.learnerId ?? null, "l.TenantId": learner?.tenantId ?? null, "l.Email": learner?.email ?? null,
      },
    };
  }).filter(({ row }) => row["l.LearnerId"] !== null);

  // lms.AnswerGrade's rules from migration 0032.
  function insertGrade(row: Row) {
    const fail = (rule: string) => { throw new Error(`The INSERT statement conflicted with the CHECK constraint "${rule}".`); };
    if (!["ai", "instructor"].includes(row.Source)) fail("CK_lms_AnswerGrade_Source");
    if (!(row.MaxScore > 0 && row.Score >= 0 && row.Score <= row.MaxScore && Number.isInteger(row.Score))) fail("CK_lms_AnswerGrade_Score");
    const ai = row.Source === "ai" && row.Model !== null && row.PromptVersion !== null && row.GradedBy === null && row.Reason === null && row.ConfirmsGradeId === null;
    const instructor = row.Source === "instructor" && row.GradedBy !== null && row.Model === null && row.PromptVersion === null;
    if (!ai && !instructor) fail("CK_lms_AnswerGrade_Who");
    if (!(row.Source === "ai" || row.ConfirmsGradeId !== null || (row.Reason !== null && String(row.Reason).trim().length > 0))) fail("CK_lms_AnswerGrade_Reason");
    if (db.grades.some((g) => same(g.TenantId, row.TenantId) && same(g.AttemptId, row.AttemptId) && g.Seq === row.Seq)) {
      throw new Error("Cannot insert duplicate key row in object 'lms.AnswerGrade' with unique index 'UX_lms_AnswerGrade_TenantAttemptSeq'.");
    }
    if (!db.responses.some((r) => same(r.attemptId, row.AttemptId) && same(r.questionId, row.QuestionId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_AnswerGrade_Response".');
    }
    if (row.ConfirmsGradeId !== null && !db.grades.some((g) => same(g.GradeId, row.ConfirmsGradeId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_AnswerGrade_Confirms".');
    }
    db.grades.push(row);
  }

  // lms.AnswerReviewRequest's rules from migration 0033.
  function checkReview(row: Row) {
    if (row.Note !== null && String(row.Note).length > 500) throw new Error("String or binary data would be truncated in column 'Note'.");
    if (!db.responses.some((r) => same(r.attemptId, row.AttemptId) && same(r.questionId, row.QuestionId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_AnswerReviewRequest_Response".');
    }
    if (row.ResolvedByGradeId !== null && !db.grades.some((g) => same(g.GradeId, row.ResolvedByGradeId))) {
      throw new Error('The statement conflicted with the FOREIGN KEY constraint "FK_lms_AnswerReviewRequest_Grade".');
    }
    if (db.reviews.some((x) => x !== row && same(x.TenantId, row.TenantId) && same(x.AttemptId, row.AttemptId) && same(x.QuestionId, row.QuestionId))) {
      throw new Error("Violation of UNIQUE KEY constraint 'UQ_lms_AnswerReviewRequest_Answer'.");
    }
  }

  function insertRow(sql: string, p: Params): Row {
    const m = /INSERT INTO lms\.(\w+) \(([^)]*)\) VALUES \((.*?)\);?$/.exec(sql);
    if (!m) throw new Error(`the fake database can't read the insert: ${sql}`);
    const cols = splitTop(m[2]!);
    const vals = splitTop(m[3]!);
    if (cols.length !== vals.length) throw new Error(`column count ${cols.length} != value count ${vals.length}`);
    const row: Row = {};
    cols.forEach((c, i) => {
      const v = vals[i]!;
      row[c] = v === "NEWID()" ? crypto.randomUUID() : /^LOWER\(CONVERT\(varchar\(36\), @(\w+)\)\)$/.test(v) ? String(p[/@(\w+)/.exec(v)![1]!]).toLowerCase() : value(v, p);
    });
    return row;
  }

  // The statement up to the next ";" at depth 0, from where `from` starts.
  function statementAt(sql: string, from: number): string {
    let depth = 0;
    for (let i = from; i < sql.length; i++) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      else if (sql[i] === ";" && depth === 0) return sql.slice(from, i);
    }
    return sql.slice(from);
  }

  function appendBatch(sql: string, p: Params): Row[] {
    const job = /IF EXISTS \(SELECT 1 FROM lms\.AnswerGradingJob WITH \(UPDLOCK, HOLDLOCK\) WHERE ([^)]*)\)/.exec(sql);
    if (job && !db.jobs.some((j) => matches(job[1]!, p, j))) return [{ Outcome: "lease_lost" }];
    const held = /EXISTS \(SELECT 1 FROM lms\.QuizAttempt a WITH \(UPDLOCK, HOLDLOCK\) JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId WHERE ([^)]*)\)/.exec(sql);
    if (!held) throw new Error("the append doesn't hold the attempt");
    if (!attemptRows().some(({ row }) => matches(held[1]!, p, row))) return [{ Outcome: "not_found" }];
    const count = /\(SELECT COUNT\(\*\) FROM lms\.AnswerGrade WHERE ([^)]*)\) = @seen/.exec(sql);
    if (!count) throw new Error("the append doesn't check the marks it read");
    if (db.grades.filter((g) => matches(count[1]!, p, g)).length !== p.seen) return [{ Outcome: "changed" }];

    const grade = insertRow(statementAt(sql, sql.indexOf("INSERT INTO lms.AnswerGrade ")), p);
    insertGrade({ Model: null, PromptVersion: null, GradedBy: null, Reason: null, ConfirmsGradeId: null, FeedbackMd: null, GradedAt: db.clock.t, ...grade });

    const score = /UPDATE a SET Score = @attemptScore FROM lms\.QuizAttempt a JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId WHERE ([^;]*);/.exec(sql);
    if (!score) throw new Error("the append doesn't write the attempt's score");
    for (const { a, row } of attemptRows()) if (matches(score[1]!, p, row)) a.score = p.attemptScore;

    const update = /UPDATE lms\.AnswerGradingJob SET (.*?) WHERE ([^;]*);/.exec(sql);
    if (update) for (const j of db.jobs) if (matches(update[2]!, p, j)) assign(update[1]!, p, j);
    if (job && !update) throw new Error("the AI append doesn't complete its job");

    const resolve = /UPDATE lms\.AnswerReviewRequest SET (.*?) WHERE ([^;]*);/.exec(sql);
    if (resolve) {
      for (const x of db.reviews) {
        if (!matches(resolve[2]!, p, x)) continue;
        assign(resolve[1]!, p, x);
        checkReview(x);
      }
    }

    const audit = sql.indexOf("INSERT INTO lms.AuditEvent ");
    if (audit >= 0) db.audit.push(insertRow(statementAt(sql, audit), p));
    return [{ Outcome: "appended" }];
  }

  function reviewBatch(sql: string, p: Params): Row[] {
    const answer = /IF EXISTS \(SELECT 1 FROM lms\.AnswerResponse r JOIN lms\.QuizAttempt a WITH \(UPDLOCK, HOLDLOCK\) ON a\.AttemptId = r\.AttemptId JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId WHERE ([^)]*)\)/.exec(sql);
    const marked = /IF EXISTS \(SELECT 1 FROM lms\.AnswerGrade WHERE ([^)]*)\)/.exec(sql);
    const asked = /IF NOT EXISTS \(SELECT 1 FROM lms\.AnswerReviewRequest WITH \(UPDLOCK, HOLDLOCK\) WHERE ([^)]*)\)/.exec(sql);
    if (!answer || !marked || !asked) throw new Error("the fake database can't read the review batch");
    const found = attemptRows().some(({ a, row }) => db.responses.some((r) => same(r.attemptId, a.attemptId)
      && matches(answer[1]!, p, { ...row, "r.AttemptId": r.attemptId, "r.QuestionId": r.questionId, "r.MachineScore": r.machineScore })));
    if (!found) return [{ Outcome: "not_found" }];
    if (!db.grades.some((g) => matches(marked[1]!, p, g))) return [{ Outcome: "not_marked" }];
    if (db.reviews.some((x) => matches(asked[1]!, p, x))) return [{ Outcome: "already" }];
    const row = { Note: null, RequestedAt: db.clock.t, ResolvedByGradeId: null, ...insertRow(statementAt(sql, sql.indexOf("INSERT INTO lms.AnswerReviewRequest ")), p) };
    checkReview(row);
    db.reviews.push(row);
    const audit = sql.indexOf("INSERT INTO lms.AuditEvent ");
    if (audit < 0) throw new Error("the review batch writes no audit event");
    db.audit.push(insertRow(statementAt(sql, audit), p));
    return [{ Outcome: "requested" }];
  }

  // The staff marking queue (listAnswersAwaitingInstructor). Each OUTER APPLY
  // is read from the statement: its table, its WHERE (a correlated
  // "= r.Column" binds this response's value), the columns it brings and
  // whether it takes the latest mark.
  function awaitingList(sql: string, p: Params): Row[] {
    const head = /^SELECT TOP \(@limit\) (.*?) FROM lms\.AnswerResponse r JOIN lms\.QuizAttempt a ON a\.AttemptId = r\.AttemptId JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId JOIN lms\.QuizQuestion qq ON qq\.QuestionId = r\.QuestionId LEFT JOIN lms\.Quiz q ON q\.QuizId = a\.QuizId LEFT JOIN lms\.Block b ON b\.BlockId = q\.BlockId LEFT JOIN lms\.Lesson ls ON ls\.LessonId = b\.LessonId LEFT JOIN lms\.Course c ON c\.CourseId = ls\.CourseId (OUTER APPLY .*)$/.exec(sql);
    if (!head) throw new Error("the fake database can't read the awaiting list");
    if (!head[1]!.includes("CASE WHEN ins.GradeId IS NULL THEN a.SubmittedAt ELSE rr.RequestedAt END AS WaitingSince, COUNT(*) OVER () AS Waiting")) {
      throw new Error("the fake database can't read the awaiting list's WaitingSince or Waiting");
    }
    const applyRe = /OUTER APPLY \(SELECT TOP \(1\) ([^()]*?) FROM lms\.(AnswerGrade|AnswerReviewRequest) (\w+) WHERE ([^()]*?)( ORDER BY \w+\.Seq DESC)?\) (\w+) /gy;
    const applies: { cols: string[]; table: Row[]; alias: string; where: string; latest: boolean; name: string }[] = [];
    let rest = head[2]!;
    let m: RegExpExecArray | null;
    while ((m = applyRe.exec(rest))) {
      applies.push({
        cols: splitTop(m[1]!).map((c) => c.slice(c.indexOf(".") + 1)), table: m[2] === "AnswerGrade" ? db.grades : db.reviews,
        alias: m[3]!, where: m[4]!, latest: Boolean(m[5]), name: m[6]!,
      });
      rest = rest.slice(applyRe.lastIndex);
      applyRe.lastIndex = 0;
    }
    const tail = /^WHERE (.*) ORDER BY WaitingSince, a\.SubmittedAt, qq\.OrderIndex$/.exec(rest);
    if (!tail || applies.length === 0) throw new Error(`the fake database can't read the awaiting list's WHERE: ${rest}`);
    const rows: Row[] = [];
    for (const { a, row } of attemptRows()) {
      const quiz = db.quizzes.find((q) => same(q.quizId, a.quizId))!;
      const learner = db.learners.find((l) => same(l.learnerId, a.learnerId))!;
      for (const r of db.responses.filter((x) => same(x.attemptId, a.attemptId))) {
        const scope: Row = { ...row, "r.AttemptId": r.attemptId, "r.QuestionId": r.questionId, "r.MachineScore": r.machineScore, "r.ResponseJson": r.responseJson };
        const bound = { ...p, __rAttemptId: r.attemptId, __rQuestionId: r.questionId };
        for (const apply of applies) {
          const where = apply.where.replace(/ = r\.(\w+)/g, (_, c: string) => ` = @__r${c}`);
          const hits = apply.table.filter((x) => matches(where, bound, Object.fromEntries(Object.entries(x).map(([k, v]) => [`${apply.alias}.${k}`, v]))));
          if (apply.latest) hits.sort((x, y) => y.Seq - x.Seq);
          if (hits.length > 1 && !apply.latest) throw new Error(`OUTER APPLY ${apply.name} found more than one row with no order`);
          for (const c of apply.cols) scope[`${apply.name}.${c}`] = hits[0]?.[c] ?? null;
        }
        if (!matches(tail[1]!, p, scope)) continue;
        const q = db.questions.find((x) => same(x.questionId, r.questionId))!;
        const date = (t: unknown) => (t === null || t === undefined ? null : new Date(t as number));
        rows.push({
          AttemptId: upper(a.attemptId), QuestionId: upper(r.questionId), LearnerId: upper(learner.learnerId), DisplayName: learner.displayName,
          SubmittedAt: new Date(a.submittedAt), ResponseJson: r.responseJson, OrderIndex: q.orderIndex, PayloadJson: JSON.stringify(q.payload),
          CourseTitle: quiz.courseTitle, LessonTitle: quiz.lessonTitle,
          AiGradeId: upper(scope["ai.GradeId"] ?? null), AiScore: scope["ai.Score"] ?? null, AiMaxScore: scope["ai.MaxScore"] ?? null,
          AiFeedbackMd: scope["ai.FeedbackMd"] ?? null, InstructorScore: scope["ins.Score"] ?? null,
          ReviewNote: scope["rr.Note"] ?? null, ReviewRequestedAt: date(scope["rr.RequestedAt"]),
          WaitingSince: date(scope["ins.GradeId"] === null ? a.submittedAt : scope["rr.RequestedAt"]),
        });
      }
    }
    const t = (d: Date | null) => (d === null ? -Infinity : d.getTime());
    rows.sort((x, y) => t(x.WaitingSince) - t(y.WaitingSince) || x.SubmittedAt - y.SubmittedAt || x.OrderIndex - y.OrderIndex);
    return rows.map((x) => ({ ...x, Waiting: rows.length })).slice(0, p.limit);
  }

  function settingsBatch(sql: string, p: Params): Row[] {
    const read = /SELECT @was = GradeWrittenAnswers FROM lms\.TenantAiSetting WITH \(UPDLOCK, HOLDLOCK\) WHERE ([^;]*);/.exec(sql);
    const update = /UPDATE lms\.TenantAiSetting SET (.*?) WHERE ([^;]*);/.exec(sql);
    const last = /COMMIT TRANSACTION; SELECT GradeWrittenAnswers, UpdatedBy, UpdatedAt FROM lms\.TenantAiSetting WHERE ([^;]*);$/.exec(sql);
    if (!read || !update || !last) throw new Error("the fake database can't read the settings batch");
    const was = db.settings.find((s) => matches(read[1]!, p, s));
    const wasOn = was ? Boolean(was.GradeWrittenAnswers) : false;
    if (!was) {
      const row = insertRow(statementAt(sql, sql.indexOf("INSERT INTO lms.TenantAiSetting ")), p);
      db.settings.push({ UpdatedAt: db.clock.t, ...row });
    } else {
      for (const s of db.settings) if (matches(update[2]!, p, s)) assign(update[1]!, p, s);
    }
    const audit = /INSERT INTO lms\.AuditEvent \(([^)]*)\) VALUES \(NEWID\(\), @tenantId, @by, '([\w.]+)', 'tenant', LOWER\(CONVERT\(varchar\(36\), @tenantId\)\), CONCAT/.exec(sql);
    if (!audit) throw new Error("the settings batch writes no audit event");
    db.audit.push({
      EventId: crypto.randomUUID(), TenantId: p.tenantId, Actor: p.by, Verb: audit[2], ObjectKind: "tenant", ObjectId: String(p.tenantId).toLowerCase(),
      MetaJson: JSON.stringify({ gradeWrittenAnswers: Boolean(p.grade), was: wasOn }),
    });
    return db.settings.filter((s) => matches(last[1]!, p, s)).map((s) => ({
      GradeWrittenAnswers: s.GradeWrittenAnswers ? 1 : 0, UpdatedBy: s.UpdatedBy, UpdatedAt: new Date(s.UpdatedAt),
    }));
  }

  function apply(sql: string, p: Params): { rows: unknown[]; count: number } {
    let m: RegExpExecArray | null;

    if (sql.startsWith("SET XACT_ABORT ON; BEGIN TRANSACTION;") && sql.includes("INSERT INTO lms.AnswerGrade ")) {
      return { rows: appendBatch(sql, p), count: 0 };
    }
    if (sql.startsWith("SET XACT_ABORT ON; BEGIN TRANSACTION;") && sql.includes("INSERT INTO lms.TenantAiSetting ")) {
      return { rows: settingsBatch(sql, p), count: 0 };
    }
    if (sql.startsWith("SET XACT_ABORT ON; BEGIN TRANSACTION;") && sql.includes("INSERT INTO lms.AnswerReviewRequest ")) {
      return { rows: reviewBatch(sql, p), count: 0 };
    }

    if ((m = /^SELECT CONVERT\(varchar\(36\), a\.AttemptId\) AS AttemptId, .* FROM lms\.QuizAttempt a JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId JOIN lms\.Quiz q ON q\.QuizId = a\.QuizId JOIN lms\.AnswerResponse r ON r\.AttemptId = a\.AttemptId JOIN lms\.QuizQuestion qq ON qq\.QuestionId = r\.QuestionId WHERE (.*) ORDER BY qq\.OrderIndex$/.exec(sql))) {
      const rows: Row[] = [];
      for (const { a, row } of attemptRows()) {
        if (!matches(m[1]!, p, row)) continue;
        const quiz = db.quizzes.find((q) => same(q.quizId, a.quizId))!;
        for (const r of db.responses.filter((x) => same(x.attemptId, a.attemptId))) {
          const q = db.questions.find((x) => same(x.questionId, r.questionId))!;
          rows.push({
            AttemptId: upper(a.attemptId), QuizId: upper(a.quizId), PassingScore: quiz.passingScore, Score: a.score,
            QuestionId: upper(r.questionId), OrderIndex: q.orderIndex, MachineScore: r.machineScore,
            PayloadJson: JSON.stringify(q.payload), ResponseJson: r.responseJson,
          });
        }
      }
      return { rows: rows.sort((x, y) => x.OrderIndex - y.OrderIndex), count: rows.length };
    }

    if ((m = /^SELECT CONVERT\(varchar\(36\), GradeId\) AS GradeId, .* FROM lms\.AnswerGrade WHERE (.*) ORDER BY Seq$/.exec(sql))) {
      const rows = db.grades.filter((g) => matches(m![1]!, p, g)).sort((x, y) => x.Seq - y.Seq).map((g) => ({
        ...g, GradeId: upper(g.GradeId), QuestionId: upper(g.QuestionId), ConfirmsGradeId: upper(g.ConfirmsGradeId), GradedAt: new Date(g.GradedAt),
      }));
      return { rows, count: rows.length };
    }

    if ((m = /^INSERT INTO lms\.AnswerGradingJob \(JobId, TenantId, AttemptId, QuestionId\) SELECT @jobId, @tenantId, r\.AttemptId, r\.QuestionId FROM lms\.AnswerResponse r JOIN lms\.QuizAttempt a ON a\.AttemptId = r\.AttemptId JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId WHERE (.*?) AND NOT EXISTS \(SELECT 1 FROM lms\.AnswerGradingJob j WHERE ([^)]*)\)$/.exec(sql))) {
      let count = 0;
      for (const { a, row } of attemptRows()) {
        for (const r of db.responses.filter((x) => same(x.attemptId, a.attemptId))) {
          if (!matches(m[1]!, p, { ...row, "r.AttemptId": r.attemptId, "r.QuestionId": r.questionId })) continue;
          if (db.jobs.some((j) => matches(m![2]!, p, j))) continue;
          if (db.jobs.some((j) => same(j.TenantId, p.tenantId) && same(j.AttemptId, r.attemptId) && same(j.QuestionId, r.questionId))) {
            throw new Error("Violation of UNIQUE KEY constraint 'UQ_lms_AnswerGradingJob_Answer'.");
          }
          db.jobs.push({
            JobId: p.jobId, TenantId: p.tenantId, AttemptId: r.attemptId, QuestionId: r.questionId, Status: "queued", Attempts: 0,
            NotBefore: db.clock.t, LeaseUntil: null, LeaseToken: null, ErrorMessage: null, UsageJson: null, ResultGradeId: null,
            CreatedAt: db.clock.t, UpdatedAt: db.clock.t,
          });
          count++;
        }
      }
      return { rows: [], count };
    }

    if ((m = /^WITH next AS \( SELECT TOP \(1\) \* FROM lms\.AnswerGradingJob WITH \(UPDLOCK, READPAST, ROWLOCK\) WHERE (.*) ORDER BY NotBefore, CreatedAt \) UPDATE next SET (.*) OUTPUT .*$/.exec(sql))) {
      const next = db.jobs.filter((j) => matches(m![1]!, p, j)).sort((x, y) => x.NotBefore - y.NotBefore || x.CreatedAt - y.CreatedAt)[0];
      if (!next) return { rows: [], count: 0 };
      assign(m[2]!, p, next);
      return {
        rows: [{ JobId: upper(next.JobId), TenantId: upper(next.TenantId), AttemptId: upper(next.AttemptId), QuestionId: upper(next.QuestionId), Attempts: next.Attempts, UsageJson: next.UsageJson }],
        count: 1,
      };
    }

    if ((m = /^UPDATE lms\.AnswerGradingJob SET (.*) WHERE (.*)$/.exec(sql))) {
      let count = 0;
      for (const j of db.jobs) {
        if (!matches(m[2]!, p, j)) continue;
        assign(m[1]!, p, j);
        count++;
      }
      return { rows: [], count };
    }

    if ((m = /^SELECT GradeWrittenAnswers, UpdatedBy, UpdatedAt FROM lms\.TenantAiSetting WHERE (.*)$/.exec(sql))) {
      const rows = db.settings.filter((s) => matches(m![1]!, p, s)).map((s) => ({
        GradeWrittenAnswers: s.GradeWrittenAnswers ? 1 : 0, UpdatedBy: s.UpdatedBy, UpdatedAt: new Date(s.UpdatedAt),
      }));
      return { rows, count: rows.length };
    }

    if (sql.startsWith("SELECT TOP (@limit) CONVERT(varchar(36), r.AttemptId) AS AttemptId,")) {
      const rows = awaitingList(sql, p);
      return { rows, count: rows.length };
    }

    if ((m = /^SELECT CONVERT\(varchar\(36\), QuestionId\) AS QuestionId, RequestedAt, CONVERT\(varchar\(36\), ResolvedByGradeId\) AS ResolvedByGradeId FROM lms\.AnswerReviewRequest WHERE (.*)$/.exec(sql))) {
      const rows = db.reviews.filter((x) => matches(m![1]!, p, x)).map((x) => ({
        QuestionId: upper(x.QuestionId), RequestedAt: new Date(x.RequestedAt), ResolvedByGradeId: upper(x.ResolvedByGradeId),
      }));
      return { rows, count: rows.length };
    }

    throw new Error(`the fake database has no answer for: ${sql}`);
  }

  function run(text: string, params: Params): { rows: unknown[]; count: number } {
    const sql = flat(text);
    db.statements.push({ sql, params });
    const fault = db.faults.before?.(sql);
    if (fault) throw fault;
    const snapshot = JSON.stringify({ grades: db.grades, jobs: db.jobs, reviews: db.reviews, settings: db.settings, audit: db.audit, attempts: db.attempts });
    try {
      return apply(sql, params);
    } catch (error) {
      const was = JSON.parse(snapshot);
      db.grades.splice(0, db.grades.length, ...was.grades);
      db.jobs.splice(0, db.jobs.length, ...was.jobs);
      db.reviews.splice(0, db.reviews.length, ...was.reviews);
      db.settings.splice(0, db.settings.length, ...was.settings);
      db.audit.splice(0, db.audit.length, ...was.audit);
      db.attempts.splice(0, db.attempts.length, ...was.attempts);
      throw error;
    }
  }

  return db;
}

// Every statement that reads or writes a tenant's rows names the tenant: each
// lms.AnswerGrade, AnswerGradingJob, AnswerReviewRequest or TenantAiSetting it reaches is filtered
// on its own TenantId in the same scope (subquery, or statement at the top),
// an insert into one carries @tenantId, and each lms.QuizAttempt is joined to
// its lms.Learner filtered on the tenant. Nested subqueries don't count for
// the scope around them. Answers what's missing, one line per gap.
const TENANT_TABLES = ["AnswerGrade", "AnswerGradingJob", "AnswerReviewRequest", "TenantAiSetting"];
const NOT_ALIAS = new Set(["WHERE", "JOIN", "ON", "SET", "WITH", "OUTPUT", "ORDER", "VALUES", "SELECT", "INNER", "LEFT", "OUTER", "GROUP"]);

export function tenantGaps(text: string): string[] {
  const sql = flat(text);
  const gaps: string[] = [];
  const re = /(INSERT INTO |FROM |JOIN |UPDATE )lms\.(\w+)\b(?: WITH \([^)]*\))?(?: (\w+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql))) {
    const table = m[2]!;
    if (!TENANT_TABLES.includes(table) && table !== "QuizAttempt") continue;
    const alias = m[3] && !NOT_ALIAS.has(m[3].toUpperCase()) ? m[3] : null;
    const scope = scopeOf(sql, m.index);
    if (m[1] === "INSERT INTO ") {
      if (TENANT_TABLES.includes(table) && !/@tenantId\b/.test(scope.whole)) gaps.push(`INSERT INTO lms.${table} without @tenantId`);
      continue;
    }
    const own = scope.own;
    if (table === "QuizAttempt") {
      const a = alias ?? "QuizAttempt";
      const join = new RegExp(`JOIN lms\\.Learner (\\w+) ON \\1\\.LearnerId = ${a}\\.LearnerId`).exec(own);
      if (!join || !new RegExp(`\\b${join[1]}\\.TenantId = @tenantId\\b`).test(own)) gaps.push(`lms.QuizAttempt ${a} not tied to the tenant's learner: ${own.slice(0, 160)}`);
      continue;
    }
    const filter = alias ? new RegExp(`\\b${alias}\\.TenantId = @tenantId\\b`) : /(^|[^.\w])TenantId = @tenantId\b/;
    if (!filter.test(own)) gaps.push(`lms.${table}${alias ? ` ${alias}` : ""} without its TenantId filter: ${own.slice(0, 160)}`);
  }
  return gaps;
}

// The innermost parenthesised group around `at`, or the ";"-statement at the
// top, with the groups nested inside it blanked out (`own`).
function scopeOf(sql: string, at: number): { whole: string; own: string } {
  let depth = 0;
  let start = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (sql[i] === ")") depth++;
    else if (sql[i] === "(") {
      if (depth === 0) { start = i + 1; break; }
      depth--;
    } else if (sql[i] === ";" && depth === 0) { start = i + 1; break; }
  }
  let end = sql.length;
  depth = 0;
  for (let i = at; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")") {
      if (depth === 0) { end = i; break; }
      depth--;
    } else if (sql[i] === ";" && depth === 0) { end = i; break; }
  }
  const whole = sql.slice(start, end);
  let own = "";
  depth = 0;
  for (const ch of whole) {
    if (ch === "(") { depth++; if (depth === 1) own += "("; continue; }
    if (ch === ")") { depth--; if (depth === 0) own += ")"; continue; }
    if (depth === 0) own += ch;
  }
  return { whole, own };
}

// ---- the whole AI marking path over the fake database ----------------------

export const TENANT = "aaaaaaaa-0000-4000-8000-00000000000a";
export const OTHER = "bbbbbbbb-0000-4000-8000-00000000000b";
export const LEARNER_A = "a1a1a1a1-0000-4000-8000-0000000000a1";
export const LEARNER_B = "b1b1b1b1-0000-4000-8000-0000000000b1";
// A second learner in TENANT, alongside LEARNER_A.
export const LEARNER_A2 = "a2a2a2a2-0000-4000-8000-0000000000a2";
export const EMAILS: Record<string, string> = {
  [LEARNER_A]: "pilot.a@a.test",
  [LEARNER_A2]: "pilot.a2@a.test",
  [LEARNER_B]: "pilot.b@b.test",
};
export const QUIZ = "c0c0c0c0-0000-4000-8000-0000000000c0";
export const SHORT_QUIZ = "c1c1c1c1-0000-4000-8000-0000000000c1";
export const Q_MCQ = "d0d0d0d0-0000-4000-8000-0000000000d0";
export const Q_SHORT = "d1d1d1d1-0000-4000-8000-0000000000d1";
export const Q_S0 = "d2d2d2d2-0000-4000-8000-0000000000d2";
export const Q_S1 = "d3d3d3d3-0000-4000-8000-0000000000d3";
export const RUBRIC = "Full marks: names the pressure difference across the wing.";
const SLUGS: Record<string, string> = { [TENANT]: "tenant-a", [OTHER]: "tenant-b" };

export interface WorldOptions {
  // AI_AUTHORING_TENANTS, the platform switch.
  platform?: string;
  // Tenants whose admin turned AI marking on.
  marking?: readonly string[];
  // TRAINING_RECORDS_TENANTS, and the database the training-record writers
  // use (lib/fixtures/fake-records-db.ts). Unset, the writers run with the
  // switch off and touch no database.
  records?: { tenants?: string; db?: unknown };
}

export type ModelReply = { score?: unknown; feedbackMd?: unknown } | Error;

const unreachable = async () => { throw new Error("the training-record writers reached a database with the switch off"); };

export function gradingWorld(options: WorldOptions = {}) {
  const db = fakeGradingDb();
  const env: Record<string, string | undefined> = {
    AI_AUTHORING_TENANTS: options.platform ?? "tenant-a,tenant-b",
    TRAINING_RECORDS_TENANTS: options.records?.tenants,
  };
  const lines: string[] = [];
  const slugReads: string[] = [];
  const sent: any[] = [];
  const model = { reply: (_params: any): ModelReply => ({ score: 4, feedbackMd: "Names the pressure difference; say why it arises." }) };

  db.learners.push(
    { learnerId: LEARNER_A, tenantId: TENANT, displayName: "Pilot A", email: EMAILS[LEARNER_A]! },
    { learnerId: LEARNER_A2, tenantId: TENANT, displayName: "Pilot A2", email: EMAILS[LEARNER_A2]! },
    { learnerId: LEARNER_B, tenantId: OTHER, displayName: "Pilot B", email: EMAILS[LEARNER_B]! },
  );
  db.quizzes.push(
    { quizId: QUIZ, passingScore: 70, courseTitle: "Principles of Flight", lessonTitle: "Lift" },
    { quizId: SHORT_QUIZ, passingScore: 70, courseTitle: "Principles of Flight", lessonTitle: "Drag" },
  );
  const short = { kind: "short", promptMd: "Why does a wing produce lift?", rubricMd: RUBRIC, maxScore: 5 } as const;
  db.questions.push(
    { questionId: Q_MCQ, quizId: QUIZ, orderIndex: 0, payload: { kind: "mcq", promptMd: "Pick", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }], correctChoiceId: "a" } },
    { questionId: Q_SHORT, quizId: QUIZ, orderIndex: 1, payload: short },
    { questionId: Q_S0, quizId: SHORT_QUIZ, orderIndex: 0, payload: short },
    { questionId: Q_S1, quizId: SHORT_QUIZ, orderIndex: 1, payload: { ...short, maxScore: 3 } },
  );
  for (const tenantId of options.marking ?? [TENANT, OTHER]) {
    db.settings.push({ TenantId: tenantId, GradeWrittenAnswers: true, UpdatedBy: "admin@example.test", UpdatedAt: db.clock.t });
  }

  const client = {
    messages: {
      create: async (params: any) => {
        sent.push(params);
        const reply = model.reply(params);
        if (reply instanceof Error) throw reply;
        return {
          model: params.model,
          stop_reason: "tool_use",
          content: [{ type: "tool_use", id: "t1", name: params.tool_choice.name, input: reply }],
          usage: { input_tokens: 1200, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 1000 },
        };
      },
    },
  };
  const logging = {
    recordServiceRun: async (...args: unknown[]) => { lines.push(args.map(String).join(" | ")); },
    recordError: async (...args: unknown[]) => { lines.push(args.map(String).join(" | ")); },
  };
  const lib = (path: string) => new URL(`../${path}`, import.meta.url);
  const tenants = { getTenantSlug: async (tenantId: string) => { slugReads.push(tenantId); return SLUGS[tenantId] ?? null; } };
  const limits = vmLoad(lib("ai/authoring/limits.ts"), { "@/lib/db/tenants": tenants }, { process: { env } });
  const aiSettings = vmLoad(lib("db/ai-settings.ts"), { "@/lib/db": db.module });
  const policy = vmLoad(lib("ai/grading/policy.ts"), { "@/lib/ai/authoring/limits": limits, "@/lib/db/ai-settings": aiSettings }, { process: { env } });
  const score = vmLoad(lib("ai/grading/score.ts"), { "./policy": policy });
  const grades = vmLoad(lib("db/answer-grades.ts"), { "node:crypto": crypto, "@/lib/db": db.module, "@/lib/schema/quiz": quizSchema });
  const util = vmLoad(lib("ai/authoring/util.ts"), { "@/lib/ai/claude": { getClaude: () => client, buildCachedSystem: claude.buildCachedSystem }, "./usage": usage });
  const writtenAnswer = vmLoad(lib("ai/grading/written-answer.ts"), {});
  const grader = vmLoad(lib("ai/grading/grader.ts"), {
    zod: { z }, "@/lib/ai/claude": { MODELS: claude.MODELS }, "@/lib/ai/authoring/util": util, "@/lib/ai/authoring/usage": usage, "./written-answer": writtenAnswer,
  });
  const job = vmLoad(lib("ai/grading/job.ts"), {
    "node:crypto": crypto, "@/lib/db/answer-grades": grades, "@/lib/logging": logging, "@/lib/ai/claude": { transientAiError: claude.transientAiError },
    "@/lib/ai/authoring/usage": usage, "./grader": grader, "./policy": policy, "./score": score,
  });
  const queue = vmLoad(lib("ai/grading/queue.ts"), { "@/lib/db/answer-grades": grades, "@/lib/logging": logging, "./grader": grader, "./policy": policy });
  const noRecordsDb = { query: unreachable, queryOne: unreachable, execute: unreachable };
  const trainingRecords = vmLoad(lib("db/training-records.ts"), {
    "node:crypto": crypto, "@/lib/db": options.records?.db ?? noRecordsDb, "@/lib/db/deadlock": deadlock, "@/lib/records/chain": chain,
  });
  const recordsSwitch = vmLoad(lib("records/switch.ts"), { "@/lib/db/tenants": tenants }, { process: { env } });
  const writers = vmLoad(lib("records/writers.ts"), { "@/lib/db/training-records": trainingRecords, "@/lib/logging": logging, "./switch": recordsSwitch });
  const instructor = vmLoad(lib("ai/grading/instructor.ts"), {
    "node:crypto": crypto, "@/lib/db/answer-grades": grades, "@/lib/records/writers": writers, "./score": score, "./written-answer": writtenAnswer,
  });
  const reviews = vmLoad(lib("db/answer-reviews.ts"), { "node:crypto": crypto, "@/lib/db": db.module });
  const learnerMarks = vmLoad(lib("ai/grading/learner-marks.ts"), { "./score": score });
  const quizzes = vmLoad(lib("db/quizzes.ts"), { "node:crypto": crypto, "@/lib/db": {}, "@/lib/db/course-scope": {}, "@/lib/schema/quiz": quizSchema });

  let attempts = 0;
  // What the submit route does: grade, record the attempt (as recordAttempt
  // writes it), then queue its written answers for marking.
  async function submit(learnerId: string, quizId: string, responses: unknown[]): Promise<{ attemptId: string; queued: number; score: number }> {
    const learner = db.learners.find((l) => l.learnerId === learnerId)!;
    const questions = db.questions.filter((q) => q.quizId === quizId).map((q) => ({ questionId: q.questionId, orderIndex: q.orderIndex, question: q.payload }));
    const graded = quizzes.gradeResponses(questions, responses);
    const attemptId = `e0e0e0e0-0000-4000-8000-${String(++attempts).padStart(12, "0")}`;
    db.attempts.push({ attemptId, quizId, learnerId, score: graded.score, submittedAt: db.clock.t + attempts });
    for (const p of graded.perQuestion) {
      db.responses.push({ attemptId, questionId: p.questionId, responseJson: JSON.stringify(responses[p.orderIndex] ?? null), machineScore: p.correct === null ? null : p.correct ? 1 : 0 });
    }
    const queued = await queue.queueAnswerMarking(learner.tenantId, attemptId, questions, responses);
    return { attemptId, queued, score: graded.score };
  }

  const storedScore = (attemptId: string) => db.attempts.find((a) => a.attemptId === attemptId)!.score;

  return { db, env, lines, slugReads, sent, model, logging, limits, aiSettings, policy, score, grades, grader, job, queue, instructor, reviews, learnerMarks, writtenAnswer, trainingRecords, writers, submit, storedScore };
}
