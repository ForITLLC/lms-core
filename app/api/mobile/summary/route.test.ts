import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(session: any, fail = false) {
  const calls: any[] = [];
  const exports: any = {};
  const modules: Record<string, unknown> = {
    "@/lib/get-session": { getSessionUser: async () => session },
    "@/lib/db/learning-summary": { getLearningSummary: async (...args: any[]) => { calls.push(args); if (fail) throw new Error("SQL secret details"); return { personal: {}, team: null }; } },
    "@/lib/logging": { recordError: async () => {} },
  };
  const code = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  runInNewContext(code, { exports, Response, require: (id: string) => modules[id] });
  return { GET: exports.GET, calls };
}

test("summary API requires authenticated tenant and never takes recipient from request", async () => {
  assert.equal((await load(null).GET()).status, 401);
  assert.equal((await load({ email: "a" }).GET()).status, 409);
  const app = load({ tenantId: "T", email: "authenticated@example.test", role: "author" });
  const response = await app.GET(new Request("https://tenant.example/api/mobile/summary?email=victim@example.test"));
  assert.equal(response.status, 200);
  assert.equal(app.calls[0][0], "T");
  assert.equal(app.calls[0][1], "authenticated@example.test");
  assert.equal(app.calls[0].length, 2);
});

test("summary backend errors fail closed without leaking SQL details", async () => {
  const response = await load({ tenantId: "T", email: "a" }, true).GET();
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /secret/);
});
