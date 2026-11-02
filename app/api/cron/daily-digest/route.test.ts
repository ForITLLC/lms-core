import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load() {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const required: string[] = [];
  runInNewContext(code, { exports, Response, process: { env: { CRON_SECRET: "s" } }, require: (id: string) => { required.push(id); return {}; } });
  return { POST: exports.POST, required };
}

const post = (auth?: string, query = "") => new Request(`https://learn.example/api/cron/daily-digest${query}`,
  { method: "POST", headers: auth ? { authorization: auth } : {} });

test("the retired summary email route sends nothing, whatever the request asks", async () => {
  const route = load();
  assert.deepEqual(route.required, [], "no mail, database or logging module is even loaded");
  assert.equal((await route.POST(post())).status, 403);
  assert.equal((await route.POST(post("Bearer wrong"))).status, 403);
  for (const query of ["", "?slug=forit", "?recipient=b@example.test", "?dryRun=true", "?relayProbe=both&recipient=b@example.test"]) {
    const response = await route.POST(post("Bearer s", query));
    assert.equal(response.status, 410);
    assert.equal((await response.json()).ok, false);
  }
});

test("the old Monday alias answers the same 410", () => {
  const alias = readFileSync(new URL("../overdue-digest/route.ts", import.meta.url), "utf8");
  assert.match(alias, /export \{ POST \} from "@\/app\/api\/cron\/daily-digest\/route"/);
});
