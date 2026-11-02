import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";
import * as summary from "../learning-summary";
import * as completion from "./completion";
import * as schedule from "./schedule";
import * as scope from "./course-scope";
import * as deadlock from "./deadlock";
import { flat, vmLoad } from "@/lib/fixtures/fake-grading-db";

// A learner marked 'left' (slice R1b) keeps their history and gets nothing
// new: no assignment, and no reminder, digest or summary mail.

function assignments(status: string | null) {
  const calls: string[] = [];
  const writes: string[] = [];
  const db = {
    query: async (sql: string) => { calls.push(flat(sql)); return []; },
    queryOne: async (sql: string) => {
      calls.push(flat(sql));
      if (sql.includes("FROM lms.Learner")) return { LearnerId: "L-1", Email: "gone@example.test", DisplayName: "Gone", Status: status };
      if (sql.includes("FROM lms.Course c")) return { CourseId: "C-1", Title: "DG", CurrentVersionId: "V-1", NeedsSeat: false };
      if (sql.includes("INSERT INTO lms.CourseAssignment")) { writes.push(flat(sql)); return { AssignmentId: "A-NEW" }; }
      return null;
    },
    execute: async (sql: string) => { writes.push(flat(sql)); return 1; },
  };
  const mod = vmLoad(new URL("./assignments.ts", import.meta.url), { "@/lib/db": db, "@/lib/db/course-scope": scope, "@/lib/db/deadlock": deadlock });
  const assign = () => mod.upsertCourseAssignment({ tenantId: "T", learnerEmail: "gone@example.test", courseSlug: "dg", assignedBy: "ops@example.test" });
  return { mod, assign, calls, writes };
}

test("a left learner is refused a new assignment before any course lookup or write; an active one is assigned", async () => {
  for (const status of ["left", "LEFT"]) {
    const { mod, assign, calls, writes } = assignments(status);
    await assert.rejects(assign(), (err: any) => {
      assert.ok(err instanceof mod.AssignmentError);
      assert.equal(err.code, "learner_left");
      assert.equal(err.message, "gone@example.test has left this organisation. Mark them active again before assigning a course.");
      return true;
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!, /^SELECT CONVERT\(varchar\(64\), LearnerId\) AS LearnerId, Email, DisplayName, Status FROM lms\.Learner WHERE TenantId = @tenantId AND Email = @email$/);
    assert.deepEqual(writes, []);
  }
  for (const status of ["active", null]) {
    const ok = assignments(status);
    assert.equal((await ok.assign()).created, true);
    assert.equal(ok.writes.length, 1);
  }
});

test("the admin API answers learner_left with 409 and the plain message", async () => {
  const { mod } = assignments("left");
  const route = vmLoad(new URL("../../app/api/admin/assignments/route.ts", import.meta.url), {
    "next/server": { NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }) } },
    zod: { z },
    "@/lib/get-session": { requireSessionUser: async () => ({ role: "admin", tenantId: "T", email: "ops@example.test" }) },
    "@/lib/db/assignments": {
      AssignmentError: mod.AssignmentError,
      listAssignmentsForCourse: async () => [],
      listAssignmentsForLearner: async () => [],
      upsertCourseAssignment: async () => { throw new mod.AssignmentError("learner_left", "gone@example.test has left this organisation."); },
    },
  });
  const res = await route.POST({ json: async () => ({ learnerEmail: "gone@example.test", courseSlug: "dg" }) });
  assert.equal(res.status, 409);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), { error: "gone@example.test has left this organisation.", code: "learner_left" });
});

test("summary mail goes to no left learner, including an admin or manager who has left", async () => {
  const statements: Array<{ sql: string; params: Record<string, unknown> }> = [];
  const mod = vmLoad(new URL("./learning-summary.ts", import.meta.url), {
    "@/lib/db": { query: async (sql: string, params: Record<string, unknown>) => { statements.push({ sql: flat(sql), params }); return []; }, queryOne: async () => null, execute: async () => 0 },
    "@/lib/learning-summary": summary, "@/lib/db/schedule": schedule, "@/lib/db/completion": completion, "@/lib/db/course-scope": scope,
    "@/lib/service-account": { isServiceAccount: () => false },
  });
  await mod.listSummaryRecipients("T");
  assert.equal(statements.length, 1);
  const sql = statements[0]!.sql;
  assert.equal(statements[0]!.params.tenantId, "T");
  assert.match(sql, /^SELECT Email, DisplayName FROM lms\.Learner WHERE TenantId = @tenantId AND Status = 'active' UNION /);
  assert.match(sql, /FROM lms\.AppUser u WHERE u\.TenantId = @tenantId AND NOT EXISTS \(SELECT 1 FROM lms\.Learner gone WHERE gone\.TenantId = @tenantId AND gone\.Email = u\.Email AND gone\.Status = 'left'\) AND \(u\.Role = 'admin' OR EXISTS \(/);
  assert.match(sql, /JOIN lms\.Learner l ON l\.LearnerId = mapping\.LearnerId AND l\.TenantId = @tenantId AND l\.Status = 'active'/);
});

test("the overdue reminder and the daily digest read only active learners, and nothing marks a learner active on sign-in", () => {
  const read = (file: string) => flat(readFileSync(new URL(file, import.meta.url), "utf8"));
  assert.match(read("./daily-digest.ts"), /FROM lms\.Learner WHERE TenantId = @tenantId AND Status = 'active' ORDER BY Email ASC/);
  assert.match(read("./overdue.ts"), /AND l\.Status = 'active'/);
  const progress = read("./progress.ts");
  const start = progress.indexOf("export async function resolveLearner(");
  const upsert = progress.slice(start, progress.indexOf("SELECT LearnerId, DisplayName FROM lms.Learner", start));
  assert.ok(start >= 0 && upsert.includes("MERGE lms.Learner AS target"));
  assert.doesNotMatch(upsert, /Status/);
});
