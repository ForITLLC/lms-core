import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";
import * as roles from "@/lib/auth/roles";

// The builder's version history: an author or admin of the session's own
// tenant only, never cached, and another tenant's course reads as not found.

const TENANT = "dddddddd-0000-0000-0000-00000000000a";
const COURSE = "dddddddd-0000-0000-0000-00000000000c";
const OTHER = "dddddddd-0000-0000-0000-00000000000d";
const VERSION = "dddddddd-0000-0000-0000-0000000000b1";

const history = {
  currentVersionId: VERSION,
  versions: [
    {
      versionId: VERSION,
      versionNumber: 1,
      publishedAt: "2026-10-28T12:00:00.000Z",
      publishedBy: "author@example.test",
      changeNote: "First cut",
      isCurrent: true,
      lessonCount: 2,
      blockCount: 5,
      enrollmentCount: 3,
    },
  ],
};

function evaluate(path: URL, modules: Record<string, unknown>) {
  const code = ts.transpileModule(readFileSync(path, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  runInNewContext(code, {
    exports, Response, JSON, Promise, Error, String,
    require: (id: string) => { if (!(id in modules)) throw new Error(`unexpected import ${id}`); return modules[id]; },
  });
  return exports;
}

type Session = { tenantId?: string; email: string; role?: string } | null;

function load(session: Session = { tenantId: TENANT, email: "author@example.test", role: "author" }, fail = false) {
  const calls: unknown[][] = [];
  const logs: string[] = [];
  const logging = {
    recordServiceRun: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); },
    recordError: async (...args: unknown[]) => { logs.push(JSON.stringify(args)); },
  };
  const gate = evaluate(new URL("../../../../../../lib/auth/staff-gate.ts", import.meta.url), {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/auth/roles": roles,
    "@/lib/logging": logging,
  });
  const versions = {
    getVersionHistory: async (...args: unknown[]) => {
      calls.push(args);
      if (fail) throw new Error("connection reset");
      return args[0] === TENANT && args[1] === COURSE ? history : null;
    },
  };
  const route = evaluate(new URL("./route.ts", import.meta.url), {
    zod: { z },
    "@/lib/auth/staff-gate": gate,
    "@/lib/db/course-versions": versions,
  });
  return { GET: (courseId: string) => route.GET(new Request("https://tenant.example/api/author/courses/x/versions"), { params: Promise.resolve({ courseId }) }) as Promise<Response>, calls, logs };
}

test("signed out is 401, no tenant is 400, a learner is 403, and none of them read the history", async () => {
  for (const [session, status] of [
    [null, 401],
    [{ email: "x@example.test", role: "author" }, 400],
    [{ tenantId: TENANT, email: "x@example.test", role: "learner" }, 403],
    [{ tenantId: TENANT, email: "x@example.test" }, 403],
  ] as const) {
    const app = load(session);
    const res = await app.GET(COURSE);
    assert.equal(res.status, status, JSON.stringify(session));
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(app.calls.length, 0);
  }
});

test("authors and admins get their own course's history, read in their session's tenant", async () => {
  for (const role of ["author", "admin"]) {
    const app = load({ tenantId: TENANT, email: `${role}@example.test`, role });
    const res = await app.GET(COURSE.toUpperCase());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), history);
    assert.deepEqual(app.calls, [[TENANT, COURSE]]);
  }
});

test("another tenant's course is 404, and something that isn't a course id is 404 without a read", async () => {
  const other = load();
  const res = await other.GET(OTHER);
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(other.calls, [[TENANT, OTHER]]);
  for (const junk of ["../../etc", "", "not-a-uuid"]) {
    const app = load();
    assert.equal((await app.GET(junk)).status, 404, junk);
    assert.equal(app.calls.length, 0, junk);
  }
});

test("a failed read is a 500 that logs the message only", async () => {
  const app = load(undefined, true);
  const res = await app.GET(COURSE);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { error: "Something went wrong" });
  assert.deepEqual(app.logs, [JSON.stringify(["lms-author", "connection reset", "ERROR"])]);
});
