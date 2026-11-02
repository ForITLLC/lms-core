import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const oid = "12345678-1234-1234-1234-123456789abc";
const png = readFileSync(new URL("./fixtures/email.png", import.meta.url));
const arrayBuffer = (bytes: Buffer): ArrayBuffer => Uint8Array.from(bytes).buffer;

function load(options: { oid?: string | null; photo?: { bytes: ArrayBuffer; contentType: string } | null; fail?: "sql" | "graph" } = {}) {
  const calls = { sql: 0, graph: [] as string[] };
  const modules: Record<string, unknown> = {
    "@/lib/db": { queryOne: async (sql: string, params: any) => {
      calls.sql++;
      assert.equal(params.tenantId, "T");
      assert.equal(params.email, "recipient@example.test");
      assert.match(sql, /l.TenantId = @tenantId AND LOWER\(l.Email\) = @email/);
      assert.match(sql, /u.TenantId = @tenantId AND LOWER\(u.Email\) = @email/);
      if (options.fail === "sql") throw new Error("SQL unavailable");
      return { AzureOid: "oid" in options ? options.oid : oid };
    } },
    "@/lib/graph": { getUserPhoto: async (actualOid: string) => { calls.graph.push(actualOid); if (options.fail === "graph") throw new Error("Graph unavailable"); return "photo" in options ? options.photo : { bytes: arrayBuffer(png), contentType: "image/png" }; } },
  };
  const code = ts.transpileModule(readFileSync(new URL("./summary-photo.ts", import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: any = {};
  runInNewContext(code, { exports, Buffer, require: (name: string) => modules[name] });
  return { get: () => exports.getSummaryRecipientPhoto("T", " Recipient@Example.test "), calls };
}

test("recipient photo only reads a tenant+email resolved valid directory identity and returns bounded CID bytes", async () => {
  const app = load();
  const photo = await app.get();
  assert.deepEqual(app.calls.graph, [oid]);
  assert.equal(photo.contentId, "learning-recipient-portrait");
  assert.equal(photo.contentType, "image/png");
  assert.equal(photo.contentBytes, png.toString("base64"));
  assert.equal(photo.isInline, true);
});

test("missing or unsafe directory identities never call Graph", async () => {
  for (const identity of [null, "", "https://graph.microsoft.com/v1.0/users/victim", "../victim", "not-guid"]) {
    const app = load({ oid: identity });
    assert.equal(await app.get(), null);
    assert.equal(app.calls.graph.length, 0);
  }
});

test("missing, oversized, unexpected and disguised image data fall back without portrait attachment", async () => {
  for (const photo of [null, { bytes: arrayBuffer(png), contentType: "image/svg+xml" },
    { bytes: arrayBuffer(Buffer.from("<svg onload='alert(1)'/>")), contentType: "image/png" },
    { bytes: new ArrayBuffer(0), contentType: "image/jpeg" },
    { bytes: new ArrayBuffer(100 * 1024 + 1), contentType: "image/jpeg" }]) {
    assert.equal(await load({ photo }).get(), null);
  }
  assert.equal(await load({ fail: "sql" }).get(), null);
  assert.equal(await load({ fail: "graph" }).get(), null);
});
