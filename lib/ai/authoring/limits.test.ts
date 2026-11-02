import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Whether a tenant may start AI authoring, and how much
// (docs/plans/2026-10-29-ai-authoring.md, slice A4). Off for every tenant
// until AI_AUTHORING_TENANTS names it, and that list stays empty until card
// f84f7899 is decided.

const TENANT = "0e0e0e0e-0000-0000-0000-00000000000a";
const OTHER = "0f0f0f0f-0000-0000-0000-00000000000f";
const GONE = "0d0d0d0d-0000-0000-0000-00000000000d";
const SLUGS: Record<string, string> = { [TENANT]: "Tenant-A", [OTHER]: "tenant-b" };

function load(processEnv: Record<string, string | undefined> = {}) {
  const reads: string[] = [];
  const code = ts.transpileModule(readFileSync(new URL("./limits.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  const modules: Record<string, unknown> = {
    "@/lib/db/tenants": { getTenantSlug: async (tenantId: string) => { reads.push(tenantId); return SLUGS[tenantId] ?? null; } },
  };
  runInNewContext(code, { exports, Set, String, process: { env: processEnv }, require: (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected import ${id}`);
    return modules[id];
  } });
  return { limits: exports, reads };
}

test("unset or empty, AI authoring is off for every tenant and no tenant is looked up", async () => {
  for (const env of [{}, { AI_AUTHORING_TENANTS: "" }, { AI_AUTHORING_TENANTS: "  " }, { AI_AUTHORING_TENANTS: " , ,," }]) {
    const { limits, reads } = load(env);
    for (const tenantId of [TENANT, OTHER, GONE]) {
      assert.equal(await limits.aiAuthoringEnabled(tenantId), false, JSON.stringify(env));
      assert.equal(await limits.aiAuthoringEnabled(tenantId, env), false, JSON.stringify(env));
    }
    assert.deepEqual(reads, []);
  }
});

test("it is on only for the tenants whose slugs are listed, matched whole and without regard to case", async () => {
  const { limits, reads } = load();
  const on = (tenantId: string, list: string) => limits.aiAuthoringEnabled(tenantId, { AI_AUTHORING_TENANTS: list });
  assert.equal(await on(TENANT, "tenant-a"), true);
  assert.equal(await on(TENANT, " TENANT-A , tenant-c"), true);
  assert.equal(await on(OTHER, "tenant-a"), false);
  assert.equal(await on(OTHER, "tenant-a,tenant-b"), true);
  for (const list of ["tenant", "tenant-a-x", "tenant-*", "*", "tenant-a;tenant-b"]) {
    assert.equal(await on(TENANT, list), false, list);
  }
  assert.equal(await on(GONE, "tenant-a,tenant-b"), false, "an inactive or unknown tenant has no slug");
  assert.equal(reads.length, 10);
  assert.ok(reads.every((id) => [TENANT, OTHER, GONE].includes(id)));
});

test("with no env passed it reads the process's AI_AUTHORING_TENANTS", async () => {
  assert.equal(await load({ AI_AUTHORING_TENANTS: "tenant-a" }).limits.aiAuthoringEnabled(TENANT), true);
  assert.equal(await load({ AI_AUTHORING_TENANTS: "tenant-b" }).limits.aiAuthoringEnabled(TENANT), false);
});

test("the caps are two jobs at once and twenty a month, per tenant, and the messages say so", () => {
  const { limits } = load();
  assert.deepEqual([limits.MAX_ACTIVE_JOBS, limits.MAX_JOBS_PER_MONTH], [2, 20]);
  assert.deepEqual(JSON.parse(JSON.stringify(limits.INGESTION_LIMITS)), { maxActive: 2, maxPerMonth: 20 });
  assert.equal(limits.limitMessage("active"), "Your organisation already has 2 AI drafts in progress, the most at once. Try again when one has finished.");
  assert.equal(limits.limitMessage("monthly"), "Your organisation has started 20 AI drafts this month, the monthly limit. More can start from the 1st of next month (UTC).");
  assert.equal(limits.AI_AUTHORING_OFF, "AI course drafting isn't turned on for this organisation.");
});

test("the switch ships empty: no env file, deploy or README turns it on", () => {
  const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
  assert.match(read(".env.example"), /^AI_AUTHORING_TENANTS=$/m);
  for (const path of [".github/workflows/deploy.yml", "README.public.md", ".env.example"]) {
    assert.doesNotMatch(read(path), /AI_AUTHORING_TENANTS=\S/, path);
  }
});
