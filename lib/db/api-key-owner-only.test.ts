import { test } from "node:test";
import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const migration = readFileSync(new URL("../../db/migrations/0037_api_key_owner_only.sql", import.meta.url), "utf8");

test("0037 adds OwnerOnly once, defaulting existing keys to full access, with no permission change", () => {
  assert.match(migration, /IF COL_LENGTH\('lms\.ApiKey', 'OwnerOnly'\) IS NULL\s+ALTER TABLE lms\.ApiKey ADD OwnerOnly BIT NOT NULL CONSTRAINT DF_lms_ApiKey_OwnerOnly DEFAULT \(0\);/);
  const sql = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(sql, /\b(GRANT|DENY|REVOKE|UPDATE|DELETE|DROP)\b/i);
});

const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

function loadApiKeys(row: Record<string, unknown> | null) {
  const calls: { sql: string; params: Record<string, unknown> }[] = [];
  const db = {
    queryOne: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return row; },
    query: async () => [],
    execute: async (sql: string, params: Record<string, unknown>) => { calls.push({ sql, params }); return 1; },
  };
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("./apiKeys.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const modules: Record<string, unknown> = { "node:crypto": crypto, "@/lib/db": db };
  runInNewContext(code, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
    return modules[name];
  } });
  return { apiKeys: exports, calls };
}

test("a key reads as full access only when the row says OwnerOnly = 0", async () => {
  for (const [stored, ownerOnly] of [[false, false], [true, true], [undefined, true], [null, true], [0, true]] as const) {
    const { apiKeys } = loadApiKeys({ TenantId: "T", AppUserId: "U", OwnerOnly: stored });
    assert.deepEqual(plain(await apiKeys.authenticateApiKey("lms_abc_def")), { tenantId: "T", appUserId: "U", ownerOnly }, String(stored));
  }
});

test("minting stores the owner-only choice and defaults to a full key", async () => {
  for (const [args, ownerOnly] of [[["T", "U", "Daily"], false], [["T", "U", "Daily", true], true]] as const) {
    const { apiKeys, calls } = loadApiKeys({ ApiKeyId: "K" });
    const minted = await apiKeys.mintApiKey(...args);
    assert.equal(minted.ownerOnly, ownerOnly);
    assert.match(calls[0]!.sql, /OwnerOnly[\s\S]*@ownerOnly/);
    assert.equal(calls[0]!.params.ownerOnly, ownerOnly);
  }
});
