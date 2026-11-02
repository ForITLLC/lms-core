import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as completion from "./completion";
import * as scope from "./course-scope";
import * as deadlock from "./deadlock";

// §5 usage: counts of the entitlement's own seat holders, read under its buyer TenantId and
// CourseId, and nothing per person leaves the SELECT.

interface Call { sql: string; params: Record<string, unknown> }

function load(file: string, modules: Record<string, unknown>) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, process: { env: {} }, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return exports;
}

function fakeDb(answer: (sql: string, params: Record<string, unknown>) => unknown = () => undefined) {
  const calls: Call[] = [];
  const record = (sql: string, params: Record<string, unknown> = {}) => {
    calls.push({ sql, params: { ...params } });
    return answer(sql, params);
  };
  return {
    calls,
    db: {
      query: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? [],
      queryOne: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? null,
      execute: async (sql: string, params?: Record<string, unknown>) => record(sql, params) ?? 1,
    },
  };
}

const flat = (sql: string) => sql.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function usage(answer?: (sql: string, params: Record<string, unknown>) => unknown) {
  const { db, calls } = fakeDb(answer);
  const entitlements = load("entitlements.ts", { "@/lib/db": db, "@/lib/db/course-scope": scope,
    "@/lib/db/deadlock": deadlock, "@/lib/db/marketplace-catalogue": { LISTABLE: "1 = 1" } });
  const mod = load("entitlement-usage.ts", { "@/lib/db": db, "@/lib/db/completion": completion, "@/lib/db/entitlements": entitlements });
  return { mod, calls };
}

const ENT = "c3a1e2f0-3333-4aaa-8bbb-000000000003";
const AT = new Date("2027-02-14T06:00:00.123Z");

async function usageSql(): Promise<string> {
  const { mod, calls } = usage(() => []);
  await mod.getEntitlementUsage(ENT, AT);
  assert.equal(calls.length, 1, "usage is one statement");
  return flat(calls[0]!.sql);
}

// Characters inside parentheses become "_", so a keyword or comma found in the mask is at the top level.
function mask(s: string): string {
  let depth = 0;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "(") out += depth++ === 0 ? ch : "_";
    else if (ch === ")") out += --depth === 0 ? ch : "_";
    else out += depth === 0 ? ch : "_";
  }
  return out;
}

// The select list of the last top-level SELECT in `s`, split on its top-level commas.
function selectList(s: string): string[] {
  const m = mask(s);
  const start = m.lastIndexOf("SELECT ") + "SELECT ".length;
  const end = m.indexOf(" FROM ", start);
  const items: string[] = [];
  let from = start;
  for (let i = start; i < end; i++) {
    if (m[i] === ",") {
      items.push(s.slice(from, i).trim());
      from = i + 1;
    }
  }
  items.push(s.slice(from, end).trim());
  return items;
}

// The text inside the parenthesised group that ends right before `marker`.
function groupBefore(s: string, marker: string): string {
  const close = s.indexOf(marker);
  assert.ok(close > 0, `no ${marker}`);
  let depth = 0;
  for (let open = close; open >= 0; open--) {
    if (s[open] === ")") depth++;
    else if (s[open] === "(" && --depth === 0) return s.slice(open + 1, close);
  }
  throw new Error(`unbalanced before ${marker}`);
}

// A learner-side read's own clause: from the table to the next join, ORDER BY or closing paren.
function clauseOf(s: string, at: number): string {
  let depth = 0;
  for (let i = at; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && depth-- === 0) return s.slice(at, i);
    if (depth === 0 && i > at && /^ (LEFT JOIN|JOIN|OUTER APPLY|CROSS APPLY|ORDER BY|GROUP BY) /.test(s.slice(i, i + 13))) {
      return s.slice(at, i);
    }
  }
  return s.slice(at);
}

const LEARNER_SIDE = /\blms\.(CourseAssignment|Enrollment|Certificate|Learner|Progress|ProgressHistory|QuizAttempt|AppUser) (\w+)/g;
// Each learner-side alias names its rows by the buyer TenantId and the entitlement's CourseId, through
// `e` (lms.Entitlement) or through `enr`, which is itself bound to `e`.
const BOUND: Record<string, string[]> = {
  a: ["a.TenantId = e.TenantId", "a.CourseId = e.CourseId", "a.EntitlementId = e.EntitlementId"],
  enr: ["enr.TenantId = e.TenantId", "enr.CourseId = e.CourseId", "enr.LearnerId = a.LearnerId"],
  cert: ["cert.TenantId = e.TenantId", "cert.CourseId = e.CourseId", "cert.LearnerId = a.LearnerId"],
  prior: ["prior.TenantId = enr.TenantId", "prior.CourseId = enr.CourseId", "prior.LearnerId = enr.LearnerId"],
};

test("usage is one read keyed on the entitlement id, with the month floor of the answer's instant", async () => {
  const { mod, calls } = usage(() => []);
  await mod.getEntitlementUsage(ENT, new Date("2027-02-28T23:59:59.999Z"));
  await mod.getEntitlementUsage(ENT, new Date("2027-03-01T00:00:00Z"));
  await mod.getEntitlementUsage(ENT, new Date("2026-12-31T23:00:00-05:00"));
  assert.deepEqual(calls.map((c) => c.params), [
    { entitlementId: ENT, monthStart: "2027-02-01" },
    { entitlementId: ENT, monthStart: "2027-03-01" },
    { entitlementId: ENT, monthStart: "2027-01-01" },
  ]);
  const sql = flat(calls[0]!.sql);
  assert.equal(sql.match(/\blms\.Entitlement e\b/g)?.length, 2);
  assert.equal(sql.match(/WHERE e\.EntitlementId = @entitlementId\b/g)?.length, 2, "both entitlement reads are by its id");
  assert.match(sql, /^WITH holder AS \(.* WHERE e\.EntitlementId = @entitlementId\) SELECT /);
  assert.match(sql, / FROM lms\.Entitlement e LEFT JOIN \(.*\) due ON 1 = 1 WHERE e\.EntitlementId = @entitlementId ORDER BY due\.RenewalMonth$/);
});

test("an unknown entitlement is null", async () => {
  const { mod } = usage(() => []);
  assert.equal(await mod.getEntitlementUsage(ENT, AT), null);
});

test("seat holders are the buyer's active assignments carrying this entitlement, on its course", async () => {
  const sql = await usageSql();
  assert.ok(sql.includes(
    "FROM lms.Entitlement e JOIN lms.CourseAssignment a ON a.TenantId = e.TenantId AND a.EntitlementId = e.EntitlementId " +
      "AND a.Status = 'active' AND a.CourseId = e.CourseId LEFT JOIN",
  ), sql);
  const live = load("entitlements.ts", { "@/lib/db": fakeDb().db, "@/lib/db/course-scope": scope,
    "@/lib/db/deadlock": deadlock, "@/lib/db/marketplace-catalogue": { LISTABLE: "1 = 1" } });
  assert.ok(sql.includes(`ON ${live.SEAT_HELD} AND`), "the same seat rule as SeatsAssigned");
});

test("every learner-side table is read under the buyer TenantId and the entitlement's CourseId", async () => {
  const sql = await usageSql();
  const seen: string[] = [];
  for (const read of sql.matchAll(LEARNER_SIDE)) {
    const alias = read[2]!;
    const clause = clauseOf(sql, read.index!);
    const needed = BOUND[alias];
    assert.ok(needed, `new learner-side read ${read[0]}; bind it to the buyer tenant and add it to BOUND`);
    for (const predicate of needed) assert.ok(clause.includes(predicate), `${read[0]} lacks ${predicate}: ${clause}`);
    seen.push(alias);
  }
  assert.deepEqual(seen.sort(), ["a", "cert", "enr", "prior"]);
  assert.doesNotMatch(sql, /@tenantId|@courseId/, "the tenant and course come from the entitlement row, never the caller");
});

test("started is an enrolment and completed is the completion marker, both per seat holder", async () => {
  const sql = await usageSql();
  assert.ok(sql.includes("CASE WHEN enr.EnrollmentId IS NULL THEN 0 ELSE 1 END AS Started"), sql);
  const marker = flat(completion.lastCompletedAt("enr"));
  assert.ok(marker.startsWith("COALESCE(enr.CompletedAt, "), "Enrollment.CompletedAt is the completion marker");
  assert.ok(sql.includes(`CASE WHEN ${marker} IS NULL THEN 0 ELSE 1 END AS Completed`), sql);
  assert.ok(sql.includes("LEFT JOIN lms.Enrollment enr ON"), "a holder with no enrolment is still assigned");
});

test("renewals: each holder's newest non-revoked certificate, counted from the month floor, keyed YYYY-MM", async () => {
  const sql = await usageSql();
  assert.ok(sql.includes(
    "OUTER APPLY (SELECT TOP 1 cert.ExpiresAt FROM lms.Certificate cert WHERE cert.TenantId = e.TenantId AND " +
      "cert.LearnerId = a.LearnerId AND cert.CourseId = e.CourseId AND cert.RevokedAt IS NULL " +
      "ORDER BY cert.CycleNo DESC, cert.IssuedAt DESC, cert.CertificateId DESC) latest",
  ), sql);
  const due = groupBefore(sql, ") due ON 1 = 1");
  assert.equal(due,
    "SELECT CONVERT(char(7), h.ExpiresAt, 23) AS RenewalMonth, COUNT(DISTINCT h.LearnerId) AS RenewalCount " +
      "FROM holder h WHERE h.ExpiresAt >= CONVERT(date, @monthStart, 23) GROUP BY CONVERT(char(7), h.ExpiresAt, 23)");
});

test("every count is of distinct learners", async () => {
  const sql = await usageSql();
  const counts = sql.match(/COUNT\([^)]*\)/g) ?? [];
  assert.equal(counts.length, 4);
  for (const count of counts) assert.equal(count, "COUNT(DISTINCT h.LearnerId)");
});

test("the SELECT returns only aggregates and month keys", async () => {
  const sql = await usageSql();
  const aggregate = /^\(SELECT COUNT\(DISTINCT h\.LearnerId\) FROM holder h(?: WHERE h\.(?:Started|Completed) = 1)?\) AS (\w+)$/;
  const names: string[] = [];
  for (const item of selectList(sql)) {
    const counted = aggregate.exec(item);
    if (counted) names.push(counted[1]!);
    else if (item === "e.Seats") names.push("Seats");
    else if (item === "due.RenewalMonth" || item === "due.RenewalCount") names.push(item.slice(4));
    else assert.fail(`the usage SELECT returns ${item}, which is not an aggregate or a month key`);
  }
  assert.deepEqual(names, ["Seats", "Assigned", "Started", "Completed", "RenewalMonth", "RenewalCount"]);
  assert.deepEqual(selectList(groupBefore(sql, ") due ON 1 = 1")), [
    "CONVERT(char(7), h.ExpiresAt, 23) AS RenewalMonth",
    "COUNT(DISTINCT h.LearnerId) AS RenewalCount",
  ], "due carries a month key and a count, never a date");
});

test("rows fold into counts and month buckets; no other column leaves the module", async () => {
  const counts = { Seats: 25, Assigned: 9, Started: 7, Completed: 5 };
  const extra = { LearnerId: "L-1", Email: "a@charter.example", ExpiresAt: "2029-01-15" };
  const { mod } = usage(() => [
    { ...counts, ...extra, RenewalMonth: "2029-01", RenewalCount: 3 },
    { ...counts, ...extra, RenewalMonth: "2029-02", RenewalCount: 2 },
  ]);
  const result = plain(await mod.getEntitlementUsage(ENT, AT));
  assert.deepEqual(result, {
    seats: 25, assigned: 9, started: 7, completed: 5, dueForRenewalByMonth: { "2029-01": 3, "2029-02": 2 },
  });
  assert.deepEqual(Object.keys(result.dueForRenewalByMonth), ["2029-01", "2029-02"]);

  const none = usage(() => [{ ...counts, RenewalMonth: null, RenewalCount: null }]);
  assert.deepEqual(plain(await none.mod.getEntitlementUsage(ENT, AT)), {
    seats: 25, assigned: 9, started: 7, completed: 5, dueForRenewalByMonth: {},
  });

  const closed = usage(() => [{ Seats: 0, Assigned: 0, Started: 0, Completed: 0, RenewalMonth: null, RenewalCount: null }]);
  assert.deepEqual(plain(await closed.mod.getEntitlementUsage(ENT, AT)), {
    seats: 0, assigned: 0, started: 0, completed: 0, dueForRenewalByMonth: {},
  });
});
