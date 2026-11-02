import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { authConfig } from "@/lib/auth-config";
import type { EntitlementUsage } from "@/lib/db/entitlement-usage";
import { FORIT_ENTRA_TENANT_ID, requireMarketplaceCaller, type MarketplaceCallerGate, type MarketplaceRole } from "./auth";
import { marketplaceError } from "./errors";
import { asOfStamp, createEntitlementUsageHandler, toUsageBody, type UsageDeps } from "./usage";

// SQL hands ids back upper case; the contract's are lower case.
const ENT = "C3A1E2F0-3333-4AAA-8BBB-000000000003";
const lower = (id: string) => id.toLowerCase();
const ROOT = new URL("../../../", import.meta.url);
const NOW = new Date("2027-02-01T06:00:00.789Z");

const USAGE: EntitlementUsage = {
  seats: 25, assigned: 9, started: 7, completed: 5, dueForRenewalByMonth: { "2029-01": 3, "2029-02": 2 },
};

const allow = async (): Promise<MarketplaceCallerGate> => ({ ok: true, caller: { appId: "MKT", roles: ["Marketplace.Usage.Read"] } });
const refuseWith = (status: 401 | 403): MarketplaceCallerGate => ({
  ok: false,
  response: marketplaceError(status, status === 401 ? "invalid_token" : "insufficient_scope", "refused"),
});
const untouched = () => {
  throw new Error("data access before the request was checked");
};

const url = (id: string) => `https://learn.forit.io/api/v1/marketplace/entitlements/${encodeURIComponent(id)}/usage`;
const ctx = (id: string) => ({ params: Promise.resolve({ orderLineId: id }) });

function reader(found: Record<string, EntitlementUsage> = { [lower(ENT)]: USAGE }) {
  const reads: Array<{ id: string; at: Date }> = [];
  const deps: UsageDeps = {
    authenticate: allow,
    getUsage: async (id, at) => {
      reads.push({ id, at });
      return found[id] ?? null;
    },
    now: () => NOW,
  };
  return { deps, reads, get: (id: string) => createEntitlementUsageHandler(deps)(new Request(url(id)), ctx(id)) };
}

async function assertError(res: Response, status: number, code: string, label = code) {
  assert.equal(res.status, status, label);
  const body = await res.json();
  assert.equal(body.error, code, label);
  assert.equal(typeof body.error_description, "string", label);
  return body;
}

test("asOf is UTC to the second, as in the contract", () => {
  assert.equal(asOfStamp(NOW), "2027-02-01T06:00:00Z");
  assert.equal(asOfStamp(new Date("2027-02-01T01:00:00.000-05:00")), "2027-02-01T06:00:00Z");
  assert.equal(asOfStamp(new Date("2029-12-31T23:59:59.999Z")), "2029-12-31T23:59:59Z");
});

test("the body is exactly the §5 shape, id lower-cased", () => {
  const body = toUsageBody(ENT, NOW, USAGE);
  assert.deepEqual(body, {
    entitlementId: lower(ENT), asOf: "2027-02-01T06:00:00Z", seats: 25, assigned: 9, started: 7, completed: 5,
    dueForRenewalByMonth: { "2029-01": 3, "2029-02": 2 },
  });
  assert.deepEqual(Object.keys(body), ["entitlementId", "asOf", "seats", "assigned", "started", "completed", "dueForRenewalByMonth"]);
});

test("an auth refusal passes through untouched, before the id is read", async () => {
  for (const status of [401, 403] as const) {
    const gate = refuseWith(status);
    const handler = createEntitlementUsageHandler({ authenticate: async () => gate, getUsage: untouched, now: untouched });
    for (const id of [ENT, "not-a-uuid"]) {
      const res = await handler(new Request(url(id)), ctx(id));
      assert.ok(!gate.ok && res === gate.response, `${status} for ${id}: the gate's own response`);
    }
  }
});

test("an id that is not a uuid is 400 invalid_request before any read", async () => {
  const handler = createEntitlementUsageHandler({ authenticate: allow, getUsage: untouched });
  const bad = ["ol_123", "", "c3a1", `${ENT}0`, `{${ENT}}`, ENT.replace(/-/g, ""), `${ENT.slice(0, -1)}g`, "../usage"];
  for (const id of bad) await assertError(await handler(new Request(url(id)), ctx(id)), 400, "invalid_request", JSON.stringify(id));
});

test("an unknown entitlement is 404 entitlement_not_found", async () => {
  const { get } = reader({});
  const body = await assertError(await get(ENT), 404, "entitlement_not_found");
  assert.equal(body.status, 404);
});

test("200: the §5 counts, the id lower-cased, read under the lower-cased id as of the answer's instant", async () => {
  const { get, reads } = reader();
  const res = await get(ENT);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, {
    entitlementId: lower(ENT), asOf: "2027-02-01T06:00:00Z", seats: 25, assigned: 9, started: 7, completed: 5,
    dueForRenewalByMonth: { "2029-01": 3, "2029-02": 2 },
  });
  assert.deepEqual(reads, [{ id: lower(ENT), at: NOW }], "the renewal month floor and asOf are the same instant");
  assert.equal((await get(lower(ENT))).status, 200, "a lower-case id is the same entitlement");
});

test("200: no renewals is an empty object, and a closed entitlement still answers its counts", async () => {
  const { get } = reader({ [lower(ENT)]: { seats: 0, assigned: 0, started: 0, completed: 0, dueForRenewalByMonth: {} } });
  const res = await get(ENT);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.dueForRenewalByMonth, {});
  assert.equal(body.seats, 0);
});

test("without an injected clock, asOf is the server's current UTC second", async () => {
  const handler = createEntitlementUsageHandler({ authenticate: allow, getUsage: async () => USAGE });
  const before = Math.floor(Date.now() / 1000) * 1000;
  const body = await (await handler(new Request(url(ENT)), ctx(ENT))).json();
  assert.match(body.asOf, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const asOf = Date.parse(body.asOf);
  assert.ok(asOf >= before && asOf <= Date.now(), body.asOf);
});

test("a tenant lms_ key, or a token without Usage.Read, is refused by the real gate", async () => {
  const CLIENT = "11111111-1111-1111-1111-111111111111";
  const CALLER = "22222222-2222-2222-2222-222222222222";
  const now = new Date("2026-10-28T12:00:00Z");
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (roles: MarketplaceRole[]) => {
    const input = `${b64({ alg: "RS256", typ: "JWT", kid: "k1" })}.${b64({
      aud: CLIENT, iss: `https://sts.windows.net/${FORIT_ENTRA_TENANT_ID}/`, exp: now.getTime() / 1000 + 3600,
      tid: FORIT_ENTRA_TENANT_ID, appid: CALLER, idtyp: "app", roles,
    })}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), keys.privateKey).toString("base64url")}`;
  };
  const { deps } = reader();
  const get = createEntitlementUsageHandler({
    ...deps,
    authenticate: (req) =>
      requireMarketplaceCaller(req, "Marketplace.Usage.Read", {
        env: { AZURE_AD_CLIENT_ID: CLIENT, MARKETPLACE_CALLER_APP_ID: CALLER },
        fetchJwks: async () => ({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] }),
        now: () => now,
      }),
  });
  const req = (authorization: string) => new Request(url(ENT), { headers: { authorization } });

  await assertError(await get(req("Bearer lms_abc_def"), ctx(ENT)), 401, "invalid_token", "lms_ key");
  await assertError(await get(new Request(url(ENT)), ctx(ENT)), 401, "invalid_token", "no token");
  const others = `Bearer ${token(["Marketplace.Entitlements.Write", "Marketplace.Catalogue.Read"])}`;
  await assertError(await get(req(others), ctx(ENT)), 403, "insufficient_scope", "every role but Usage.Read");
  assert.equal((await get(req(`Bearer ${token(["Marketplace.Usage.Read"])}`), ctx(ENT))).status, 200);
});

// ---- plumbing --------------------------------------------------------------

const ROUTE = "app/api/v1/marketplace/entitlements/[orderLineId]/usage/route.ts";
const source = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

test("GET is logged by withApiLogging and gated on Marketplace.Usage.Read", () => {
  const route = source(ROUTE);
  assert.match(route, /export const GET = withApiLogging\("marketplace_get_usage", createEntitlementUsageHandler\(\{/);
  assert.match(route, /authenticate: \(req\) => requireMarketplaceCaller\(req, "Marketplace\.Usage\.Read"\)/);
  assert.match(route, /getUsage: getEntitlementUsage/);
  assert.equal(route.match(/requireMarketplaceCaller\(/g)?.length, 1);
  assert.doesNotMatch(route, /requireApiKey|lib\/api\/bearer/, "a tenant key must never read usage");
  assert.match(route, /`orderLineId` here holds an entitlementId/);
});

test("the usage route needs no cookie session and stays out of /api/openapi.json", () => {
  const on = (paths: string[] | undefined, path: string) => (paths ?? []).some((p) => path === p || path.startsWith(`${p}/`));
  const path = `/api/v1/marketplace/entitlements/${lower(ENT)}/usage`;
  assert.ok(on(authConfig.publicPaths, path), path);
  assert.ok(!on(authConfig.staffPaths, path), path);
  assert.doesNotMatch(source("app/api/openapi.json/route.ts"), /marketplace/i);
});
