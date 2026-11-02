import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(cookie: unknown, currentRole: () => Promise<string>) {
  const source = readFileSync(new URL("./get-session.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: any = {};
  const errors: string[] = [];
  const modules: Record<string, unknown> = {
    react: { cache: (fn: unknown) => fn },
    "next/headers": { headers: async () => ({ get: () => null }) },
    "@foritllc/auth": { createGetSession: () => async () => cookie },
    "@/lib/logging": { recordError: async (_s: string, m: string) => { errors.push(m); } },
    "@/lib/auth-config": { authConfig: {} },
    "@/lib/db/mobileKeys": { hasDeviceKeyShape: () => false, sessionForDeviceKey: async () => null },
    "@/lib/db/users": { currentAppUserRole: currentRole },
  };
  runInNewContext(code, { exports, Error, require: (name: string) => { if (!(name in modules)) throw new Error(name); return modules[name]; } });
  return { mod: exports, errors };
}

const cookie = { email: "pilot@x.test", name: "Pilot", azureOid: "O", expiresAt: 0, tenantId: "T", role: "author" };

test("a 30-day cookie's author role yields to the stored role", async () => {
  const { mod } = load(cookie, async () => "learner");
  assert.equal((await mod.getSessionUser()).role, "learner");
});

test("a failed role read answers learner and logs", async () => {
  const { mod, errors } = load({ ...cookie, role: "admin" }, async () => { throw new Error("db down"); });
  assert.equal((await mod.getSessionUser()).role, "learner");
  assert.match(errors[0]!, /session\.role: db down/);
});

test("an unbound session is left alone", async () => {
  const { tenantId: _t, role: _r, ...unbound } = cookie;
  const { mod } = load(unbound, async () => { throw new Error("must not be called"); });
  assert.equal((await mod.getSessionUser()).role, undefined);
});
