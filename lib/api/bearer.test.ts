import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function load(path: URL, modules: Record<string, unknown>) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(path, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, Response, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
    return modules[name];
  } });
  return exports;
}

const keys: Record<string, { tenantId: string; appUserId: string; ownerOnly: boolean }> = {
  lms_full: { tenantId: "T", appUserId: "U", ownerOnly: false },
  lms_own: { tenantId: "T", appUserId: "U", ownerOnly: true },
};
const { requireApiKey } = load(new URL("./bearer.ts", import.meta.url), {
  "next/server": { NextResponse: Response },
  "@/lib/db/apiKeys": { authenticateApiKey: async (key: string) => keys[key] ?? null },
});
const call = (key: string | null, options?: unknown) =>
  requireApiKey(new Request("https://t.example.test/api/v1/x", { headers: key ? { authorization: `Bearer ${key}` } : {} }), options);

test("a missing or unknown key is a 401", async () => {
  for (const key of [null, "lms_nope"]) {
    const gate = await call(key);
    assert.equal(gate.ok, false);
    assert.equal(gate.response.status, 401);
  }
});

test("an owner-only key is refused with insufficient_scope unless the endpoint accepts it", async () => {
  const refused = await call("lms_own");
  assert.equal(refused.ok, false);
  assert.equal(refused.response.status, 403);
  assert.match(refused.response.headers.get("www-authenticate"), /error="insufficient_scope"/);
  assert.equal((await refused.response.json()).error, "insufficient_scope");
  for (const options of [{}, { allowOwnerOnly: false }, { allowOwnerOnly: "yes" }]) assert.equal((await call("lms_own", options)).ok, false);
  const accepted = await call("lms_own", { allowOwnerOnly: true });
  assert.deepEqual(plain(accepted), { ok: true, ctx: keys.lms_own });
});

test("a full key passes whether or not the endpoint accepts owner-only keys", async () => {
  assert.deepEqual(plain(await call("lms_full")), { ok: true, ctx: keys.lms_full });
  assert.deepEqual(plain(await call("lms_full", { allowOwnerOnly: true })), { ok: true, ctx: keys.lms_full });
});

function routes(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? routes(path) : name === "route.ts" ? [path] : [];
  });
}

test("only the learning summary accepts owner-only keys", () => {
  const app = fileURLToPath(new URL("../../app", import.meta.url));
  const accepting = routes(app).filter((path) => /allowOwnerOnly/.test(readFileSync(path, "utf8")));
  assert.deepEqual(accepting.map((path) => path.slice(app.length)), ["/api/v1/learning-summary/route.ts"]);
});
