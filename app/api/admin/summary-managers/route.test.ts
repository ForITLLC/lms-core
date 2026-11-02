import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { z } from "zod";

function load(role: string | null, options: { session?: any; missing?: boolean } = {}) {
  const calls: any[] = [];
  const exports: any = {};
  const modules: Record<string, unknown> = {
    zod: { z },
    "@/lib/get-session": { getSessionUser: async () => "session" in options ? options.session : ({ tenantId: "T", email: "admin@example.test", role: "admin" }) },
    "@/lib/db/learning-summary": {
      getSummaryIdentity: async (tenant: string, email: string) => { assert.equal(tenant, "T"); assert.equal(email, "admin@example.test"); return role ? { Role: role } : null; },
      listSummaryManagers: async (tenant: string) => { assert.equal(tenant, "T"); return []; },
      setSummaryManager: async (...args: any[]) => { calls.push(args); return !options.missing; },
    },
    "@/lib/logging": { recordError: async () => {}, recordServiceRun: async () => {} },
  };
  const code = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports, Date, Response, require: (id: string) => modules[id] });
  return { ...exports, calls };
}
const request = (body: unknown) => new Request("https://tenant.example/api/admin/summary-managers", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("manager settings ignore stale session admin role and require current database admin", async () => {
  for (const role of [null, "learner", "author"]) {
    const app = load(role);
    assert.equal((await app.GET()).status, 403);
    assert.equal((await app.PUT(request({ manager_email: "manager@example.test", learner_email: "learner@example.test", enabled: true }))).status, 403);
    assert.equal(app.calls.length, 0);
  }
  assert.equal((await load("admin", { session: null }).GET()).status, 401);
});

test("admin mapping updates are tenant-bound, reject extra tenant input and support immediate revoke", async () => {
  const app = load("admin");
  const body = { manager_email: "manager@example.test", learner_email: "learner@example.test", enabled: false };
  assert.equal((await app.PUT(request({ ...body, tenantId: "OTHER" }))).status, 400);
  assert.equal((await app.PUT(request(body))).status, 200);
  assert.equal(app.calls[0][0], "T");
  assert.equal(app.calls[0][3], false);
  assert.equal(app.calls[0][4], "admin@example.test");
  assert.equal((await load("admin", { missing: true }).PUT(request(body))).status, 404);
});
