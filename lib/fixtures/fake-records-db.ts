import { readFileSync } from "node:fs";
import * as crypto from "node:crypto";
import { z } from "zod";
import * as deadlock from "@/lib/db/deadlock";
import * as chain from "@/lib/records/chain";
import { vmLoad } from "./fake-grading-db";

// An in-memory database for the training-record tests (slices R1a, R2a):
// lms.TrainingRecord, lms.TrainingRecordChain, lms.PersonnelLink, and the lms.Learner,
// Enrollment, Course, QuizAttempt, Quiz, Block and Lesson rows the writers
// read about the event they record. Each statement is matched by its shape
// and every WHERE it carries is read from the statement's own text, so a
// tenant filter missing from the SQL is missing here too. Migration 0034's
// CHECK, UNIQUE and FOREIGN KEY rules on lms.TrainingRecord are enforced
// (its Kind and Result lists are read from the migration itself), its
// triggers refuse any UPDATE or DELETE of a record, and a batch that breaks
// a rule changes nothing. Migration 0036's rules are enforced too: a
// correction carries its reason, names a record of the same tenant and
// learner, and a record is corrected once; lms.PersonnelLink keeps its
// CHECK, FOREIGN KEY and UNIQUE rules (its duty positions read from 0036)
// and refuses any UPDATE or DELETE. BIGINT columns come back as strings and GUIDs and
// hashes upper-case, as tedious and CONVERT return them.

type Row = Record<string, any>;
type Params = Record<string, any>;

export const flat = (sql: string) => sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const same = (a: unknown, b: unknown) =>
  a !== null && a !== undefined && b !== null && b !== undefined && String(a).toLowerCase() === String(b).toLowerCase();
const upper = (v: unknown) => (v === null || v === undefined ? null : String(v).toUpperCase());

const MIGRATION = flat(readFileSync(new URL("../../db/migrations/0034_training_records.sql", import.meta.url), "utf8"));
const listIn = (name: string) => {
  const m = new RegExp(`CONSTRAINT CK_lms_TrainingRecord_${name} CHECK \\(${name} IN \\(([^)]*)\\)\\)`).exec(MIGRATION);
  if (!m) throw new Error(`no ${name} list in migration 0034`);
  return m[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
};
const KINDS = listIn("Kind");
const RESULTS = listIn("Result");
const MIGRATION_0036 = flat(readFileSync(new URL("../../db/migrations/0036_personnel_link.sql", import.meta.url), "utf8"));
const DUTY_POSITIONS = (() => {
  const m = /CONSTRAINT CK_lms_PersonnelLink_DutyPosition CHECK \(DutyPosition IN \(([^)]*)\)\)/.exec(MIGRATION_0036);
  if (!m) throw new Error("no DutyPosition list in migration 0036");
  return m[1]!.split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
})();
const MANUAL_KINDS = ["check", "ojt", "line_indoc", "familiarization", "monitor", "qualification", "vendor_training", "acp_ppc"];

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
  throw new Error(`no column ${name}`);
}

export interface Statement {
  sql: string;
  params: Params;
}

export interface FakeRecordsDb {
  learners: Row[];
  courses: Row[];
  enrollments: Row[];
  quizzes: Row[];
  blocks: Row[];
  lessons: Row[];
  attempts: Row[];
  chain: Row[];
  records: Row[];
  personnelLinks: Row[];
  statements: Statement[];
  faults: { before?: (sql: string) => Error | undefined };
  module: {
    query: (sql: string, p?: Params) => Promise<unknown[]>;
    queryOne: (sql: string, p?: Params) => Promise<unknown>;
    execute: (sql: string, p?: Params) => Promise<number>;
  };
}

export function fakeRecordsDb(): FakeRecordsDb {
  const db: FakeRecordsDb = {
    learners: [], courses: [], enrollments: [], quizzes: [], blocks: [], lessons: [], attempts: [], chain: [], records: [], personnelLinks: [],
    statements: [],
    faults: {},
    module: {
      query: async (sql, p = {}) => run(sql, p),
      queryOne: async (sql, p = {}) => run(sql, p)[0] ?? null,
      execute: async (sql, p = {}) => run(sql, p).length,
    },
  };

  const matches = (where: string, p: Params, row: Row): boolean =>
    splitTop(where, " AND ").every((part): boolean => {
      let m: RegExpExecArray | null;
      if ((m = /^([\w.]+) (=|>=|<) @(\w+)$/.exec(part))) {
        if (!(m[3]! in p)) throw new Error(`no parameter @${m[3]}`);
        const have = column(row, m[1]!);
        const want = p[m[3]!];
        if (m[2] === "=") return same(have, want);
        const a = have instanceof Date ? have.getTime() : Number(have);
        const b = want instanceof Date ? want.getTime() : Number(want);
        return m[2] === ">=" ? a >= b : a < b;
      }
      if ((m = /^([\w.]+) IS NOT NULL$/.exec(part))) return column(row, m[1]!) !== null;
      if ((m = /^([\w.]+) IS NULL$/.exec(part))) return column(row, m[1]!) === null;
      throw new Error(`the fake database can't read the condition: ${part}`);
    });

  const outRecord = (r: Row): Row => ({
    ...r,
    RecordId: upper(r.RecordId), TenantId: upper(r.TenantId), Seq: String(r.Seq), LearnerId: upper(r.LearnerId),
    CourseId: upper(r.CourseId), CourseVersionId: upper(r.CourseVersionId), QuizId: upper(r.QuizId), AttemptId: upper(r.AttemptId),
    CorrectsRecordId: upper(r.CorrectsRecordId), OccurredAt: new Date(r.OccurredAt), RecordedAt: new Date(r.RecordedAt),
  });

  const fail = (rule: string) => { throw new Error(`The INSERT statement conflicted with the CHECK constraint "${rule}".`); };

  // lms.TrainingRecord's rules from migration 0034.
  function insertRecord(row: Row) {
    const blank = (v: unknown) => v === null || v === undefined || String(v).trim().length === 0;
    if (!(Number(row.Seq) >= 1)) fail("CK_lms_TrainingRecord_Seq");
    if (!KINDS.includes(row.Kind)) fail("CK_lms_TrainingRecord_Kind");
    if (!RESULTS.includes(row.Result)) fail("CK_lms_TrainingRecord_Result");
    if (!["auto", "manual", "backfill"].includes(row.Source)) fail("CK_lms_TrainingRecord_Source");
    const kindResult = (row.Kind === "course_completion" && row.Result === "completed")
      || (row.Kind === "exam_pass" && row.Result === "pass")
      || (row.Kind === "exam_fail" && row.Result === "fail")
      || (row.Kind === "exam_attempt_pending" && row.Result === "pending")
      || (row.Kind === "grade_change" && ["pass", "fail"].includes(row.Result))
      || (MANUAL_KINDS.includes(row.Kind) && ["pass", "fail", "completed", "attended", "incomplete"].includes(row.Result));
    if (!kindResult) fail("CK_lms_TrainingRecord_KindResult");
    const inRange = (v: unknown) => v === null || (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100);
    const scored = row.Score !== null && row.PassingScore !== null;
    if (!inRange(row.Score) || !inRange(row.PassingScore)
      || (["exam_pass", "exam_fail", "grade_change"].includes(row.Kind) && !scored)
      || (row.Result === "pass" && scored && row.Score < row.PassingScore)
      || (row.Result === "fail" && scored && row.Score >= row.PassingScore)) fail("CK_lms_TrainingRecord_Score");
    if (row.Result === "fail" && blank(row.FailureDetail)) fail("CK_lms_TrainingRecord_FailureDetail");
    if (blank(row.RecordedBy)) fail("CK_lms_TrainingRecord_RecordedBy");
    if (row.CorrectsRecordId !== null && same(row.CorrectsRecordId, row.RecordId)) fail("CK_lms_TrainingRecord_Corrects");
    if (row.PayloadJson !== null) {
      try { JSON.parse(row.PayloadJson); } catch { fail("CK_lms_TrainingRecord_PayloadJson"); }
    }
    for (const name of ["PrevHash", "RowHash"]) if (!/^[0-9A-F]{64}$/.test(row[name])) fail(`CK_lms_TrainingRecord_${name}`);
    if (row.PersonName === null || row.PersonEmail === null) throw new Error("Cannot insert the value NULL into a person column.");
    if (String(row.PersonName).length > 256 || String(row.CourseTitle ?? "").length > 256 || String(row.FailureDetail ?? "").length > 1000) {
      throw new Error("String or binary data would be truncated.");
    }
    if (db.records.some((r) => same(r.TenantId, row.TenantId) && Number(r.Seq) === Number(row.Seq))) {
      throw new Error("Violation of UNIQUE KEY constraint 'UQ_lms_TrainingRecord_TenantSeq'.");
    }
    if (db.records.some((r) => same(r.RecordId, row.RecordId))) throw new Error("Violation of PRIMARY KEY constraint 'PK_lms_TrainingRecord'.");
    if (!db.learners.some((l) => same(l.LearnerId, row.LearnerId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_TrainingRecord_Learner".');
    }
    if (row.CorrectsRecordId !== null) {
      // 0036: the reason is a non-blank scalar at $.correctionReason.
      let reason: unknown = null;
      try {
        const payload = row.PayloadJson === null ? null : JSON.parse(row.PayloadJson);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) reason = payload.correctionReason;
      } catch { /* not JSON: no reason */ }
      if (!(["string", "number", "boolean"].includes(typeof reason) && String(reason).trim().length > 0)) fail("CK_lms_TrainingRecord_CorrectionReason");
      if (db.records.some((r) => same(r.CorrectsRecordId, row.CorrectsRecordId))) {
        throw new Error(`Cannot insert duplicate key row in object 'lms.TrainingRecord' with unique index 'UX_lms_TrainingRecord_Corrects'. The duplicate key value is (${row.CorrectsRecordId}).`);
      }
      const corrected = db.records.find((r) => same(r.RecordId, row.CorrectsRecordId));
      if (!corrected) throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_TrainingRecord_Corrects".');
      if (!same(corrected.TenantId, row.TenantId) || !same(corrected.LearnerId, row.LearnerId)) {
        throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_TrainingRecord_CorrectsSamePerson".');
      }
    }
    db.records.push({ ...row, Seq: Number(row.Seq) });
  }

  // lms.PersonnelLink's rules from migration 0036.
  function insertLink(row: Row) {
    const blank = (v: unknown) => v === null || v === undefined || String(v).trim().length === 0;
    const linkFail = (rule: string) => { throw new Error(`The INSERT statement conflicted with the CHECK constraint "${rule}".`); };
    if (!DUTY_POSITIONS.includes(row.DutyPosition)) linkFail("CK_lms_PersonnelLink_DutyPosition");
    if (row.LeaveDate !== null && row.HireDate !== null && row.LeaveDate < row.HireDate) linkFail("CK_lms_PersonnelLink_Dates");
    if (blank(row.RecordedBy)) linkFail("CK_lms_PersonnelLink_RecordedBy");
    if (row.SupersedesLinkId !== null && same(row.SupersedesLinkId, row.PersonnelLinkId)) linkFail("CK_lms_PersonnelLink_Supersedes");
    if (row.SupersedesLinkId !== null && blank(row.Reason)) linkFail("CK_lms_PersonnelLink_Reason");
    for (const name of ["HireDate", "LeaveDate", "EffectiveFrom"]) {
      const v = row[name];
      if (v === null) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) !== v) {
        throw new Error("Conversion failed when converting date and/or time from character string.");
      }
    }
    if (row.EffectiveFrom === null || row.DutyPosition === null) throw new Error("Cannot insert the value NULL into a PersonnelLink column.");
    if (String(row.EmployeeNo ?? "").length > 64 || String(row.CrewRecordsPersonRef ?? "").length > 128 || String(row.Reason ?? "").length > 1000) {
      throw new Error("String or binary data would be truncated.");
    }
    if (db.personnelLinks.some((l) => same(l.PersonnelLinkId, row.PersonnelLinkId))) throw new Error("Violation of PRIMARY KEY constraint 'PK_lms_PersonnelLink'.");
    if (row.SupersedesLinkId !== null && db.personnelLinks.some((l) => same(l.SupersedesLinkId, row.SupersedesLinkId))) {
      throw new Error(`Cannot insert duplicate key row in object 'lms.PersonnelLink' with unique index 'UX_lms_PersonnelLink_Supersedes'. The duplicate key value is (${row.SupersedesLinkId}).`);
    }
    if (!db.learners.some((l) => same(l.TenantId, row.TenantId) && same(l.LearnerId, row.LearnerId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_PersonnelLink_Learner".');
    }
    if (row.SupersedesLinkId !== null
      && !db.personnelLinks.some((l) => same(l.TenantId, row.TenantId) && same(l.LearnerId, row.LearnerId) && same(l.PersonnelLinkId, row.SupersedesLinkId))) {
      throw new Error('The INSERT statement conflicted with the FOREIGN KEY constraint "FK_lms_PersonnelLink_Supersedes".');
    }
    db.personnelLinks.push({ ...row, RecordedAt: new Date(row.RecordedAt) });
  }

  function insertValues(statement: string, p: Params): Row {
    const m = /^INSERT INTO lms\.(\w+) \(([^)]*)\) VALUES \((.*)\)$/.exec(statement);
    if (!m) throw new Error(`the fake database can't read the insert: ${statement}`);
    const cols = splitTop(m[2]!);
    const vals = splitTop(m[3]!);
    if (cols.length !== vals.length) throw new Error(`column count ${cols.length} != value count ${vals.length}`);
    const row: Row = {};
    cols.forEach((c, i) => {
      const v = vals[i]!;
      let x: RegExpExecArray | null;
      if ((x = /^@(\w+)$/.exec(v))) {
        if (!(x[1]! in p)) throw new Error(`no parameter @${x[1]}`);
        row[c] = p[x[1]!] ?? null;
      } else if ((x = /^CONVERT\(varbinary\(32\), @(\w+), 2\)$/.exec(v))) {
        if (!/^[0-9a-fA-F]{64}$/.test(String(p[x[1]!]))) throw new Error(`@${x[1]} is not 32 bytes of hex`);
        row[c] = String(p[x[1]!]).toUpperCase();
      } else if (/^\d+$/.test(v)) {
        row[c] = Number(v);
      } else {
        throw new Error(`the fake database can't evaluate: ${v}`);
      }
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
    const learner = /IF EXISTS \(SELECT 1 FROM lms\.Learner WHERE ([^)]*)\) AND \(@correctsRecordId IS NULL OR EXISTS \(SELECT 1 FROM lms\.TrainingRecord WHERE ([^)]*)\)\)/.exec(sql);
    if (!learner) throw new Error("the append doesn't check the learner and the record it corrects are the tenant's");
    if (!db.learners.some((l) => matches(learner[1]!, p, l))) return [{ Outcome: "not_found" }];
    if (p.correctsRecordId !== null && !db.records.some((r) => matches(learner[2]!, p, r))) return [{ Outcome: "not_found" }];

    const created = /IF NOT EXISTS \(SELECT 1 FROM lms\.TrainingRecordChain WITH \(UPDLOCK, HOLDLOCK\) WHERE ([^)]*)\) INSERT INTO lms\.TrainingRecordChain /.exec(sql);
    if (!created) throw new Error("the append doesn't create the chain head under UPDLOCK, HOLDLOCK");
    if (!db.chain.some((c) => matches(created[1]!, p, c))) {
      const head = insertValues(statementAt(sql, sql.indexOf("INSERT INTO lms.TrainingRecordChain ")), p);
      if (db.chain.some((c) => same(c.TenantId, head.TenantId))) throw new Error("Violation of PRIMARY KEY constraint 'PK_lms_TrainingRecordChain'.");
      db.chain.push(head);
    }

    const locked = /SELECT @lastSeq = LastSeq, @lastHash = LastHash FROM lms\.TrainingRecordChain WITH \(UPDLOCK, HOLDLOCK\) WHERE ([^;]*);/.exec(sql);
    if (!locked) throw new Error("the append doesn't read the chain head under UPDLOCK, HOLDLOCK");
    // SELECT @v = col over several rows keeps the last one.
    const head = db.chain.filter((c) => matches(locked[1]!, p, c)).pop();
    if (!/IF @lastSeq = @expectedSeq AND @lastHash = CONVERT\(varbinary\(32\), @prevHash, 2\) BEGIN/.test(sql)) {
      throw new Error("the append doesn't check the head still names what it chained from");
    }
    if (!head || head.LastSeq !== Number(p.expectedSeq) || head.LastHash !== String(p.prevHash).toUpperCase()) return [{ Outcome: "changed" }];

    insertRecord(insertValues(statementAt(sql, sql.indexOf("INSERT INTO lms.TrainingRecord (")), p));
    const moved = /UPDATE lms\.TrainingRecordChain SET LastSeq = @seq, LastHash = CONVERT\(varbinary\(32\), @rowHash, 2\), UpdatedAt = SYSUTCDATETIME\(\) WHERE ([^;]*);/.exec(sql);
    if (!moved) throw new Error("the append doesn't move the chain head");
    for (const c of db.chain) {
      if (matches(moved[1]!, p, c)) {
        c.LastSeq = Number(p.seq);
        c.LastHash = String(p.rowHash).toUpperCase();
      }
    }
    return [{ Outcome: "appended" }];
  }

  function transaction(work: () => Row[]): Row[] {
    const saved = { chain: db.chain.map((c) => ({ ...c })), records: db.records.map((r) => ({ ...r })) };
    try {
      return work();
    } catch (error) {
      db.chain = saved.chain;
      db.records = saved.records;
      throw error;
    }
  }

  function run(raw: string, p: Params): Row[] {
    const sql = flat(raw);
    db.statements.push({ sql, params: { ...p } });
    const fault = db.faults.before?.(sql);
    if (fault) throw fault;

    if (/^(UPDATE|DELETE( FROM)?) lms\.TrainingRecord\b(?!Chain)/.test(sql) || /^MERGE lms\.TrainingRecord\b(?!Chain)/.test(sql)) {
      throw new Error("lms.TrainingRecord is append-only: a correction is a new row that names the record it corrects.");
    }

    if (/^UPDATE lms\.PersonnelLink\b/.test(sql) || /^MERGE lms\.PersonnelLink\b/.test(sql)) {
      throw new Error("lms.PersonnelLink is append-only: a change is a new row, and a row entered wrongly is superseded by one that names it.");
    }
    if (/^DELETE( FROM)? lms\.PersonnelLink\b/.test(sql)) throw new Error("lms.PersonnelLink is append-only: rows are never deleted.");

    let m: RegExpExecArray | null;
    if ((m = /^INSERT INTO lms\.PersonnelLink \(([^)]*)\) SELECT (.*) WHERE EXISTS \(SELECT 1 FROM lms\.Learner WHERE ([^)]*)\) AND \(@supersedesLinkId IS NULL OR EXISTS \(SELECT 1 FROM lms\.PersonnelLink WHERE ([^)]*)\)\)$/.exec(sql))) {
      if (!db.learners.some((l) => matches(m![3]!, p, l))) return [];
      if (p.supersedesLinkId !== null && !db.personnelLinks.some((l) => matches(m![4]!, p, l))) return [];
      const row = insertValues(`INSERT INTO lms.PersonnelLink (${m[1]}) VALUES (${m[2]})`, p);
      insertLink(row);
      return [{}];
    }
    if ((m = /^SELECT CONVERT\(varchar\(36\), PersonnelLinkId\) AS PersonnelLinkId, .* FROM lms\.PersonnelLink WHERE (.*) ORDER BY EffectiveFrom, RecordedAt$/.exec(sql))) {
      return db.personnelLinks
        .filter((l) => matches(m![1]!, p, l))
        .sort((a, b) => (a.EffectiveFrom < b.EffectiveFrom ? -1 : a.EffectiveFrom > b.EffectiveFrom ? 1 : a.RecordedAt - b.RecordedAt))
        .map((l) => ({ ...l, PersonnelLinkId: upper(l.PersonnelLinkId), LearnerId: upper(l.LearnerId), SupersedesLinkId: upper(l.SupersedesLinkId), RecordedAt: new Date(l.RecordedAt) }));
    }
    if ((m = /^SELECT CONVERT\(varchar\(36\), LearnerId\) AS LearnerId, Email, DisplayName, Status FROM lms\.Learner WHERE (.*?)( ORDER BY DisplayName)?$/.exec(sql))) {
      const rows = db.learners.filter((l) => matches(m![1]!, p, l));
      if (m[2]) rows.sort((a, b) => String(a.DisplayName).localeCompare(String(b.DisplayName)));
      return rows.map((l) => ({ LearnerId: upper(l.LearnerId), Email: l.Email, DisplayName: l.DisplayName, Status: l.Status }));
    }
    if (sql.startsWith("SET XACT_ABORT ON; BEGIN TRANSACTION;") && sql.includes("INSERT INTO lms.TrainingRecord (")) {
      return transaction(() => appendBatch(sql, p));
    }
    if ((m = /^SELECT DisplayName, Email FROM lms\.Learner WHERE (.*)$/.exec(sql))) {
      return db.learners.filter((l) => matches(m![1]!, p, l)).map((l) => ({ DisplayName: l.DisplayName, Email: l.Email }));
    }
    if ((m = /^SELECT LastSeq, CONVERT\(varchar\(64\), LastHash, 2\) AS LastHash FROM lms\.TrainingRecordChain WHERE (.*)$/.exec(sql))) {
      return db.chain.filter((c) => matches(m![1]!, p, c)).map((c) => ({ LastSeq: String(c.LastSeq), LastHash: c.LastHash }));
    }
    if ((m = /^SELECT (TOP \(@limit\) )?CONVERT\(varchar\(36\), RecordId\) AS RecordId, .* FROM lms\.TrainingRecord WHERE (.*) ORDER BY (.*)$/.exec(sql))) {
      const rows = db.records.filter((r) => matches(m![2]!, p, r));
      if (m[3] === "Seq") rows.sort((a, b) => a.Seq - b.Seq);
      else if (m[3] === "OccurredAt DESC, Seq DESC") rows.sort((a, b) => b.OccurredAt - a.OccurredAt || b.Seq - a.Seq);
      else throw new Error(`the fake database can't order by ${m[3]}`);
      return (m[1] ? rows.slice(0, Number(p.limit)) : rows).map(outRecord);
    }
    if ((m = /^SELECT l\.Email, CONVERT\(varchar\(36\), e\.CourseId\) AS CourseId, .* FROM lms\.Enrollment e JOIN lms\.Learner l ON l\.LearnerId = e\.LearnerId JOIN lms\.Course c ON c\.CourseId = e\.CourseId WHERE (.*)$/.exec(sql))) {
      const joined = db.enrollments.flatMap((e) => {
        const l = db.learners.find((x) => same(x.LearnerId, e.LearnerId));
        const c = db.courses.find((x) => same(x.CourseId, e.CourseId));
        if (!l || !c) return [];
        return [{
          "e.LearnerId": e.LearnerId, "e.CourseId": e.CourseId, "e.TenantId": e.TenantId, "e.CompletedAt": e.CompletedAt, "l.TenantId": l.TenantId,
          out: { Email: l.Email, CourseId: upper(e.CourseId), VersionId: upper(e.VersionId), Title: c.Title, CompletedAt: e.CompletedAt === null ? null : new Date(e.CompletedAt), CycleNo: e.CycleNo },
        }];
      });
      return joined.filter((r) => matches(m![1]!, p, r)).map((r) => r.out);
    }
    if ((m = /^SELECT CONVERT\(varchar\(36\), a\.LearnerId\) AS LearnerId, l\.Email, .* FROM lms\.QuizAttempt a JOIN lms\.Learner l ON l\.LearnerId = a\.LearnerId JOIN lms\.Quiz q ON q\.QuizId = a\.QuizId JOIN lms\.Block b ON b\.BlockId = q\.BlockId JOIN lms\.Lesson s ON s\.LessonId = b\.LessonId JOIN lms\.Course c ON c\.CourseId = s\.CourseId WHERE (.*)$/.exec(sql))) {
      const joined = db.attempts.flatMap((a) => {
        const l = db.learners.find((x) => same(x.LearnerId, a.LearnerId));
        const q = db.quizzes.find((x) => same(x.QuizId, a.QuizId));
        const b = q && db.blocks.find((x) => same(x.BlockId, q.BlockId));
        const s = b && db.lessons.find((x) => same(x.LessonId, b.LessonId));
        const c = s && db.courses.find((x) => same(x.CourseId, s.CourseId));
        if (!l || !c) return [];
        return [{
          "a.AttemptId": a.AttemptId, "l.TenantId": l.TenantId,
          out: { LearnerId: upper(a.LearnerId), Email: l.Email, QuizId: upper(a.QuizId), CourseId: upper(c.CourseId), VersionId: upper(b!.VersionId), Title: c.Title, SubmittedAt: a.SubmittedAt === null ? null : new Date(a.SubmittedAt), IsExam: q!.IsExam === true },
        }];
      });
      return joined.filter((r) => matches(m![1]!, p, r)).map((r) => r.out);
    }
    throw new Error(`the fake database doesn't know the statement: ${sql.slice(0, 160)}`);
  }

  return db;
}

export const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const LEARNER_A = "a1a1a1a1-0000-4000-8000-0000000000a1";
export const LEARNER_A2 = "a2a2a2a2-0000-4000-8000-0000000000a2";
export const LEARNER_B = "b1b1b1b1-0000-4000-8000-0000000000b1";
export const COURSE = "c0c0c0c0-0000-4000-8000-00000000c0c0";
export const VERSION = "c1c1c1c1-0000-4000-8000-00000000c1c1";
export const LESSON = "c2c2c2c2-0000-4000-8000-00000000c2c2";
export const BLOCK = "c3c3c3c3-0000-4000-8000-00000000c3c3";
export const QUIZ = "c4c4c4c4-0000-4000-8000-00000000c4c4";
export const PRACTICE_QUIZ = "c5c5c5c5-0000-4000-8000-00000000c5c5";
export const COURSE_TITLE = "Principles of Flight";
const SLUGS: Record<string, string> = { [TENANT_A]: "tenant-a", [TENANT_B]: "tenant-b" };

export interface RecordsWorldOptions {
  // TRAINING_RECORDS_TENANTS.
  tenants?: string;
}

// The writers over the fake database, with two tenants, their learners and
// one course holding an exam (QUIZ) and a practice quiz (PRACTICE_QUIZ).
export function recordsWorld(options: RecordsWorldOptions = {}) {
  const db = fakeRecordsDb();
  const env: Record<string, string | undefined> = { TRAINING_RECORDS_TENANTS: options.tenants };
  const lines: string[] = [];
  const slugReads: string[] = [];
  db.learners.push(
    { LearnerId: LEARNER_A, TenantId: TENANT_A, DisplayName: "Pilot A", Email: "pilot.a@example.test", Status: "active" },
    { LearnerId: LEARNER_A2, TenantId: TENANT_A, DisplayName: "Pilot A2", Email: "pilot.a2@example.test", Status: "left" },
    { LearnerId: LEARNER_B, TenantId: TENANT_B, DisplayName: "Pilot B", Email: "pilot.b@example.test", Status: "active" },
  );
  db.courses.push({ CourseId: COURSE, Title: COURSE_TITLE });
  db.lessons.push({ LessonId: LESSON, CourseId: COURSE });
  db.blocks.push({ BlockId: BLOCK, LessonId: LESSON, VersionId: VERSION });
  db.quizzes.push({ QuizId: QUIZ, BlockId: BLOCK, IsExam: true }, { QuizId: PRACTICE_QUIZ, BlockId: BLOCK, IsExam: false });

  const logging = {
    recordServiceRun: async (...args: unknown[]) => { lines.push(args.map(String).join(" | ")); },
    recordError: async (...args: unknown[]) => { lines.push(args.map(String).join(" | ")); },
  };
  const tenants = { getTenantSlug: async (tenantId: string) => { slugReads.push(tenantId); return SLUGS[tenantId.toLowerCase()] ?? null; } };
  const lib = (path: string) => new URL(`../${path}`, import.meta.url);
  // An append's waits between tries are recorded and not slept, so a test
  // sees how long a writer would wait without waiting.
  const waits: number[] = [];
  const records = vmLoad(lib("db/training-records.ts"), {
    "node:crypto": crypto, "@/lib/db": db.module, "@/lib/db/deadlock": deadlock, "@/lib/records/chain": chain,
  }, { setTimeout: (done: () => void, ms: number) => { waits.push(ms); return setTimeout(done, 0); } });
  const recordsSwitch = vmLoad(lib("records/switch.ts"), { "@/lib/db/tenants": tenants }, { process: { env } });
  const writers = vmLoad(lib("records/writers.ts"), { "@/lib/db/training-records": records, "@/lib/logging": logging, "./switch": recordsSwitch });
  // Slice R2a: records entered by hand, corrections, personnel rows, the import.
  const manual = vmLoad(lib("records/manual.ts"), { zod: { z }, "@/lib/db/training-records": records });
  const corrections = vmLoad(lib("records/corrections.ts"), { zod: { z }, "@/lib/db/training-records": records, "./manual": manual });
  const personnelLinks = vmLoad(lib("db/personnel-links.ts"), { "node:crypto": crypto, "@/lib/db": db.module });
  const personnel = vmLoad(lib("records/personnel.ts"), { zod: { z }, "@/lib/db/personnel-links": personnelLinks });
  const csv = vmLoad(lib("records/csv.ts"), {});
  const imports = vmLoad(lib("records/import.ts"), {
    "node:crypto": crypto, "@/lib/db/training-records": records, "./corrections": corrections, "./csv": csv, "./manual": manual,
  }, { Buffer });

  let attempts = 0;
  const attempt = (learnerId: string, submittedAt = new Date("2026-10-29T09:00:00.000Z"), quizId = QUIZ) => {
    const attemptId = `e0e0e0e0-0000-4000-8000-${String(++attempts).padStart(12, "0")}`;
    db.attempts.push({ AttemptId: attemptId, QuizId: quizId, LearnerId: learnerId, SubmittedAt: submittedAt });
    return attemptId;
  };
  const enroll = (learnerId: string, tenantId: string, completedAt: Date | null, cycleNo = 1) => {
    db.enrollments.push({ LearnerId: learnerId, CourseId: COURSE, TenantId: tenantId, VersionId: VERSION, CompletedAt: completedAt, CycleNo: cycleNo });
  };

  return {
    db, env, lines, slugReads, waits, logging, records, recordsSwitch, writers, attempt, enroll,
    manual, corrections, personnelLinks, personnel, csv, imports,
  };
}
