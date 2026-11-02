import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { authConfig } from "@/lib/auth-config";
import type { BuyerTenant, EntitledCourse, StoredEntitlement } from "@/lib/db/entitlements";
import { FORIT_ENTRA_TENANT_ID, requireMarketplaceCaller, type MarketplaceCallerGate, type MarketplaceRole } from "./auth";
import {
  createEntitlementGetHandler,
  createEntitlementPutHandler,
  decidePut,
  parsePutBody,
  toEntitlementBody,
  type EntitlementPutDeps,
  type PutDecision,
  type PutInput,
  type PutState,
} from "./entitlements";
import { marketplaceError } from "./errors";

// SQL hands ids back upper case; the contract's are lower case.
const ENT = "C3A1E2F0-3333-4AAA-8BBB-000000000003";
const COURSE = "8D0C1E2A-1111-4AAA-8BBB-000000000001";
const VERSION = "41B2C3D4-2222-4AAA-8BBB-000000000002";
const VERSION_2 = "41B2C3D4-2222-4AAA-8BBB-000000000005";
const lower = (id: string) => id.toLowerCase();
const ROOT = new URL("../../../", import.meta.url);

const BUYER: BuyerTenant = { TenantId: "T-CHARTER", Slug: "charter" };
const LISTED: EntitledCourse = { CourseId: COURSE, PublisherTenantId: "T-ACME", Slug: "dg-air", Listable: true, VersionServed: true };
const UNLISTED: EntitledCourse = { ...LISTED, Listable: false };
const DRAFT_VERSION: EntitledCourse = { ...LISTED, VersionServed: false };

const BODY = { tenantSlug: "charter", courseId: lower(COURSE), versionId: lower(VERSION), seats: 25, accessUntil: "2027-11-30" };
const INPUT: PutInput = { orderLineId: "ol_123", ...BODY };

function stored(over: Partial<StoredEntitlement> = {}): StoredEntitlement {
  return {
    EntitlementId: ENT, OrderLineId: "ol_123", TenantId: "T-CHARTER", TenantSlug: "charter", CourseId: COURSE, VersionId: VERSION,
    Seats: 25, SeatsAssigned: 9, AccessUntil: "2027-11-30", Status: "active", ...over,
  };
}
const CLOSED = stored({ Seats: 0, SeatsAssigned: 0, Status: "closed" });

function state(over: Partial<PutState> = {}): PutState {
  return { existing: null, buyer: BUYER, course: LISTED, slugConflict: false, ...over };
}

function outcome(d: PutDecision): string {
  if (d.kind === "refuse") return `${d.status} ${d.code}`;
  return d.kind === "answer" ? "200 no write" : d.kind;
}

// ---- body validation -------------------------------------------------------

test("a valid body parses, ids lower-cased; accessUntil may be null but must be present", () => {
  assert.deepEqual(parsePutBody("ol_123", { ...BODY, courseId: COURSE, versionId: VERSION }), { ok: true, input: INPUT });
  assert.deepEqual(parsePutBody("ol_123", { ...BODY, accessUntil: null }), { ok: true, input: { ...INPUT, accessUntil: null } });
  for (const id of ["A", "a".repeat(128), "OL-1.2_3:x", "0"]) assert.equal(parsePutBody(id, BODY).ok, true, id);
  for (const accessUntil of ["2028-02-29", "2000-02-29", "0001-01-01", "9999-12-31", "2027-12-31"]) {
    assert.equal(parsePutBody("ol_1", { ...BODY, accessUntil }).ok, true, accessUntil);
  }
  for (const seats of [0, 1, 100_000, 25.0]) assert.equal(parsePutBody("ol_1", { ...BODY, seats }).ok, true, String(seats));
});

test("every malformed orderLineId or body is refused", () => {
  const { accessUntil: _drop, ...noAccessUntil } = BODY;
  const bad: Array<[string, string, unknown]> = [
    ["empty orderLineId", "", BODY],
    ["129-char orderLineId", "a".repeat(129), BODY],
    ["slash", "ol/1", BODY],
    ["space", "ol 1", BODY],
    ["quote", "ol'1", BODY],
    ["unicode", "olé", BODY],
    ["no body", "ol_1", undefined],
    ["null body", "ol_1", null],
    ["array body", "ol_1", [BODY]],
    ["string body", "ol_1", "{}"],
    ["unknown key", "ol_1", { ...BODY, status: "active" }],
    ["accessUntil missing", "ol_1", noAccessUntil],
    ["upper-case slug", "ol_1", { ...BODY, tenantSlug: "CHARTER" }],
    ["slug edge hyphen", "ol_1", { ...BODY, tenantSlug: "-charter" }],
    ["slug not a string", "ol_1", { ...BODY, tenantSlug: 7 }],
    ["courseId not a uuid", "ol_1", { ...BODY, courseId: "8d0c" }],
    ["versionId braced", "ol_1", { ...BODY, versionId: `{${lower(VERSION)}}` }],
    ["versionId missing", "ol_1", { ...BODY, versionId: undefined }],
    ["seats negative", "ol_1", { ...BODY, seats: -1 }],
    ["seats too many", "ol_1", { ...BODY, seats: 100_001 }],
    ["seats fractional", "ol_1", { ...BODY, seats: 1.5 }],
    ["seats a string", "ol_1", { ...BODY, seats: "25" }],
    ["seats null", "ol_1", { ...BODY, seats: null }],
    ["not a leap year", "ol_1", { ...BODY, accessUntil: "2027-02-29" }],
    ["1900 not a leap year", "ol_1", { ...BODY, accessUntil: "1900-02-29" }],
    ["month 13", "ol_1", { ...BODY, accessUntil: "2027-13-01" }],
    ["day 31 in a 30-day month", "ol_1", { ...BODY, accessUntil: "2027-11-31" }],
    ["day 0", "ol_1", { ...BODY, accessUntil: "2027-11-00" }],
    ["year 0", "ol_1", { ...BODY, accessUntil: "0000-01-01" }],
    ["unpadded", "ol_1", { ...BODY, accessUntil: "2027-1-01" }],
    ["a timestamp", "ol_1", { ...BODY, accessUntil: "2027-11-30T00:00:00Z" }],
    ["a number", "ol_1", { ...BODY, accessUntil: 20271130 }],
  ];
  for (const [label, id, body] of bad) {
    const parsed = parsePutBody(id, body);
    assert.equal(parsed.ok, false, label);
    assert.ok(!parsed.ok && parsed.description.length > 0, label);
  }
});

// ---- decidePut: the §3 order -----------------------------------------------

test("decidePut answers each step before the next is checked", () => {
  const cases: Array<[string, Partial<PutInput>, Partial<PutState>, string]> = [
    // 3. order line identity
    ["other tenantSlug", { tenantSlug: "acme" }, { existing: stored() }, "409 order_line_mismatch"],
    ["other courseId", { courseId: "00000000-0000-4000-8000-000000000000" }, { existing: stored() }, "409 order_line_mismatch"],
    ["courseId compared case-insensitively", {}, { existing: stored({ CourseId: COURSE }) }, "200 no write"],
    ["mismatch beats closed", { tenantSlug: "acme" }, { existing: CLOSED }, "409 order_line_mismatch"],
    ["mismatch beats closed, seats 0", { tenantSlug: "acme", seats: 0 }, { existing: CLOSED }, "409 order_line_mismatch"],
    ["mismatch beats tenant_not_found", { tenantSlug: "gone" }, { existing: stored(), buyer: null, course: null }, "409 order_line_mismatch"],
    // 4. closed stays closed
    ["closed, seats 0 is a retry", { seats: 0 }, { existing: CLOSED }, "200 no write"],
    ["closed, seats 0 ignores other fields", { seats: 0, versionId: lower(VERSION_2), accessUntil: null }, { existing: CLOSED }, "200 no write"],
    ["closed retry beats 404s", { seats: 0 }, { existing: CLOSED, buyer: null, course: null }, "200 no write"],
    ["closed, seats above 0", { seats: 5 }, { existing: CLOSED }, "409 entitlement_closed"],
    ["closed beats 404s", { seats: 5 }, { existing: CLOSED, buyer: null, course: null }, "409 entitlement_closed"],
    // 5. 404s
    ["unknown buyer", {}, { buyer: null }, "404 tenant_not_found"],
    ["tenant before course", {}, { buyer: null, course: null }, "404 tenant_not_found"],
    ["a buyer deactivated since purchase still gets its refund", { seats: 9 }, { existing: stored(), buyer: null }, "update"],
    ["a buyer deactivated since purchase, identical retry", {}, { existing: stored(), buyer: null }, "200 no write"],
    ["unknown course or version", {}, { course: null }, "404 course_not_found"],
    ["course_not_found beats not listable", {}, { course: null, slugConflict: true }, "404 course_not_found"],
    // 6. listable on create or a version change only
    ["create, unlisted", {}, { course: UNLISTED }, "422 course_not_listable"],
    ["create, version above current", {}, { course: DRAFT_VERSION }, "422 course_not_listable"],
    ["not listable beats slug_conflict", {}, { course: UNLISTED, slugConflict: true }, "422 course_not_listable"],
    ["not listable beats seats 0 on create", { seats: 0 }, { course: UNLISTED }, "422 course_not_listable"],
    ["new version, unlisted", { versionId: lower(VERSION_2) }, { existing: stored(), course: UNLISTED }, "422 course_not_listable"],
    ["new version, a draft", { versionId: lower(VERSION_2) }, { existing: stored(), course: DRAFT_VERSION }, "422 course_not_listable"],
    ["refund after unlisting", { seats: 9 }, { existing: stored(), course: UNLISTED }, "update"],
    ["close after unlisting", { seats: 0 }, { existing: stored({ SeatsAssigned: 0 }), course: UNLISTED }, "update"],
    ["same version in upper case is no change", { seats: 9 }, { existing: stored({ VersionId: VERSION }), course: DRAFT_VERSION }, "update"],
    // 7. slug clash on create only
    ["create, slug clash", {}, { slugConflict: true }, "409 slug_conflict"],
    ["slug clash beats seats 0 on create", { seats: 0 }, { slugConflict: true }, "409 slug_conflict"],
    ["slug clash ignored on an existing line", {}, { existing: stored(), slugConflict: true }, "200 no write"],
    // 8. identical retry
    ["identical", {}, { existing: stored() }, "200 no write"],
    ["identical, no end date", { accessUntil: null }, { existing: stored({ AccessUntil: null }) }, "200 no write"],
    // 9. a change, guarded
    ["more seats", { seats: 30 }, { existing: stored() }, "update"],
    ["seats down to the assigned count", { seats: 9 }, { existing: stored() }, "update"],
    ["seats below assigned", { seats: 8 }, { existing: stored() }, "409 seats_below_assigned"],
    ["close with seats assigned", { seats: 0 }, { existing: stored() }, "409 seats_below_assigned"],
    ["close with none assigned", { seats: 0 }, { existing: stored({ SeatsAssigned: 0 }) }, "update"],
    ["new end date", { accessUntil: "2028-11-30" }, { existing: stored() }, "update"],
    ["end date removed", { accessUntil: null }, { existing: stored() }, "update"],
    ["end date added", {}, { existing: stored({ AccessUntil: null }) }, "update"],
    ["new listed version", { versionId: lower(VERSION_2) }, { existing: stored() }, "update"],
    // 10. create
    ["create", {}, {}, "insert"],
    ["create with seats 0", { seats: 0 }, {}, "400 invalid_request"],
    ["404 beats seats 0 on create", { seats: 0 }, { buyer: null }, "404 tenant_not_found"],
  ];
  for (const [label, input, over, expected] of cases) {
    assert.equal(outcome(decidePut({ ...INPUT, ...input }, state(over))), expected, label);
  }
});

test("a mismatch names the stored tenantSlug and courseId", () => {
  const d = decidePut({ ...INPUT, tenantSlug: "acme" }, state({ existing: stored({ TenantSlug: "charter", CourseId: COURSE }) }));
  assert.ok(d.kind === "refuse");
  assert.deepEqual(d.extra, { tenantSlug: "charter", courseId: lower(COURSE) });
});

test("seats_below_assigned carries the assigned count", () => {
  const d = decidePut({ ...INPUT, seats: 3 }, state({ existing: stored({ SeatsAssigned: 7 }) }));
  assert.ok(d.kind === "refuse");
  assert.deepEqual(d.extra, { seatsAssigned: 7 });
});

test("a retry answers the stored entitlement itself", () => {
  const existing = stored();
  assert.deepEqual(decidePut(INPUT, state({ existing })), { kind: "answer", entitlement: existing });
  assert.deepEqual(decidePut({ ...INPUT, seats: 0 }, state({ existing: CLOSED })), { kind: "answer", entitlement: CLOSED });
});

test("the create is the buyer's row; the change keeps the entitlement's own id and tenant", () => {
  assert.deepEqual(decidePut(INPUT, state()), {
    kind: "insert",
    row: { orderLineId: "ol_123", tenantId: "T-CHARTER", courseId: lower(COURSE), versionId: lower(VERSION), seats: 25, accessUntil: "2027-11-30" },
  });
  const change = { ...INPUT, versionId: lower(VERSION_2), seats: 0, accessUntil: null };
  assert.deepEqual(decidePut(change, state({ existing: stored({ SeatsAssigned: 0 }) })), {
    kind: "update",
    change: { entitlementId: ENT, tenantId: "T-CHARTER", versionId: lower(VERSION_2), seats: 0, accessUntil: null },
  });
});

test("the response is exactly the §3 entitlement, ids lower-cased", () => {
  const body = toEntitlementBody(stored());
  assert.deepEqual(body, {
    entitlementId: lower(ENT), orderLineId: "ol_123", tenantSlug: "charter", courseId: lower(COURSE), versionId: lower(VERSION),
    seats: 25, seatsAssigned: 9, accessUntil: "2027-11-30", status: "active",
  });
  assert.equal(toEntitlementBody(stored({ AccessUntil: null })).accessUntil, null);
});

// ---- handlers --------------------------------------------------------------

const allow = async (): Promise<MarketplaceCallerGate> => ({ ok: true, caller: { appId: "MKT", roles: ["Marketplace.Entitlements.Write"] } });
const refuseWith = (status: 401 | 403): MarketplaceCallerGate => ({
  ok: false,
  response: marketplaceError(status, status === 401 ? "invalid_token" : "insufficient_scope", "refused"),
});
const untouched = () => {
  throw new Error("data access before the request was checked");
};

// An in-memory lms.Entitlement whose UPDATE applies the same guard as the SQL.
function store(rows: StoredEntitlement[] = []) {
  const byLine = new Map(rows.map((r) => [r.OrderLineId, { ...r }]));
  const writes: string[] = [];
  const deps: EntitlementPutDeps = {
    authenticate: allow,
    findEntitlement: async (id) => {
      const row = byLine.get(id);
      return row ? { ...row } : null;
    },
    resolveBuyer: async (slug) => (slug === BUYER.Slug ? BUYER : null),
    findCourse: async (courseId, versionId) =>
      courseId === lower(COURSE) && [lower(VERSION), lower(VERSION_2)].includes(versionId) ? LISTED : null,
    buyerOwnsSlug: async () => false,
    insertEntitlement: async (row) => {
      writes.push("insert");
      if (byLine.has(row.orderLineId)) return false;
      byLine.set(row.orderLineId, {
        EntitlementId: ENT, OrderLineId: row.orderLineId, TenantId: row.tenantId, TenantSlug: BUYER.Slug,
        CourseId: row.courseId.toUpperCase(), VersionId: row.versionId.toUpperCase(), Seats: row.seats, SeatsAssigned: 0,
        AccessUntil: row.accessUntil, Status: "active",
      });
      return true;
    },
    updateEntitlement: async (change) => {
      writes.push("update");
      const row = [...byLine.values()].find((r) => r.EntitlementId === change.entitlementId && r.TenantId === change.tenantId);
      if (!row || row.Status !== "active" || change.seats < row.SeatsAssigned) return false;
      Object.assign(row, {
        Seats: change.seats, VersionId: change.versionId.toUpperCase(), AccessUntil: change.accessUntil,
        Status: change.seats === 0 ? "closed" : "active",
      });
      return true;
    },
  };
  return { deps, writes, byLine };
}

const url = (orderLineId: string) => `https://learn.forit.io/api/v1/marketplace/entitlements/${encodeURIComponent(orderLineId)}`;
const ctx = (orderLineId: string) => ({ params: Promise.resolve({ orderLineId }) });

function putter(deps: EntitlementPutDeps) {
  const handler = createEntitlementPutHandler(deps);
  return (orderLineId: string, body: unknown, raw?: string) =>
    handler(new Request(url(orderLineId), { method: "PUT", body: raw ?? JSON.stringify(body) }), ctx(orderLineId));
}

async function assertError(res: Response, status: number, code: string, label = code) {
  assert.equal(res.status, status, label);
  const body = await res.json();
  assert.equal(body.error, code, label);
  assert.equal(typeof body.error_description, "string", label);
  return body;
}

test("PUT and GET: an auth refusal passes through untouched, before the id or body is read", async () => {
  for (const status of [401, 403] as const) {
    const gate = refuseWith(status);
    const deps: EntitlementPutDeps = {
      authenticate: async () => gate, findEntitlement: untouched, resolveBuyer: untouched, findCourse: untouched,
      buyerOwnsSlug: untouched, insertEntitlement: untouched, updateEntitlement: untouched,
    };
    const put = await putter(deps)("bad id/", null, "not json");
    assert.ok(!gate.ok && put === gate.response, "the gate's own response");
    const get = await createEntitlementGetHandler(deps)(new Request(url("bad id/")), ctx("bad id/"));
    assert.ok(!gate.ok && get === gate.response, "the gate's own response");
  }
});

test("PUT: a malformed id or body is 400 invalid_request before any read", async () => {
  const deps: EntitlementPutDeps = {
    authenticate: allow, findEntitlement: untouched, resolveBuyer: untouched, findCourse: untouched,
    buyerOwnsSlug: untouched, insertEntitlement: untouched, updateEntitlement: untouched,
  };
  const put = putter(deps);
  await assertError(await put("ol 1", BODY), 400, "invalid_request", "orderLineId");
  await assertError(await put("ol_1", null, "{not json"), 400, "invalid_request", "not JSON");
  await assertError(await put("ol_1", null, ""), 400, "invalid_request", "empty body");
  await assertError(await put("ol_1", { ...BODY, extra: 1 }), 400, "invalid_request", "unknown key");
  await assertError(await put("ol_1", { ...BODY, accessUntil: "2027-02-30" }), 400, "invalid_request", "not a date");
});

test("PUT: a create is 201 with the entitlement, and its retry is 200 with no second write", async () => {
  const { deps, writes } = store();
  const put = putter(deps);
  const expected = {
    entitlementId: lower(ENT), orderLineId: "ol_123", tenantSlug: "charter", courseId: lower(COURSE), versionId: lower(VERSION),
    seats: 25, seatsAssigned: 0, accessUntil: "2027-11-30", status: "active",
  };
  const created = await put("ol_123", { ...BODY, courseId: COURSE, versionId: VERSION });
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), expected);
  const retry = await put("ol_123", BODY);
  assert.equal(retry.status, 200);
  assert.deepEqual(await retry.json(), expected);
  assert.deepEqual(writes, ["insert"]);
});

test("PUT: seats 0 on a new order line is 400 and writes nothing", async () => {
  const { deps, writes } = store();
  await assertError(await putter(deps)("ol_1", { ...BODY, seats: 0 }), 400, "invalid_request");
  assert.deepEqual(writes, []);
});

test("PUT: losing a concurrent create re-reads and answers as a retry, or as a mismatch", async () => {
  for (const [winner, status, code] of [
    [stored({ SeatsAssigned: 0 }), 200, undefined],
    [stored({ TenantSlug: "acme", TenantId: "T-ACME" }), 409, "order_line_mismatch"],
  ] as const) {
    const { deps, writes, byLine } = store();
    let reads = 0;
    const race: EntitlementPutDeps = {
      ...deps,
      findEntitlement: async (id) => (reads++ === 0 ? null : deps.findEntitlement(id)),
      insertEntitlement: async (row) => {
        byLine.set(row.orderLineId, { ...winner });
        return deps.insertEntitlement(row);
      },
    };
    const res = await putter(race)("ol_123", BODY);
    assert.equal(res.status, status);
    const body = await res.json();
    if (code) assert.deepEqual([body.error, body.tenantSlug, body.courseId], [code, "acme", lower(COURSE)]);
    else assert.deepEqual(body, toEntitlementBody(winner));
    assert.deepEqual(writes, ["insert"], "decided once more, not written again");
  }
});

test("PUT: a change is 200 with the entitlement as re-read; a close stamps closed", async () => {
  const { deps, writes } = store([stored()]);
  const put = putter(deps);
  const more = await put("ol_123", { ...BODY, seats: 30, versionId: lower(VERSION_2) });
  assert.equal(more.status, 200);
  assert.deepEqual(await more.json(), { ...toEntitlementBody(stored()), seats: 30, versionId: lower(VERSION_2) });

  const none = store([stored({ SeatsAssigned: 0 })]);
  const closed = await putter(none.deps)("ol_123", { ...BODY, seats: 0 });
  assert.equal(closed.status, 200);
  assert.equal((await closed.json()).status, "closed");
  const again = await putter(none.deps)("ol_123", { ...BODY, seats: 0 });
  assert.equal(again.status, 200);
  await assertError(await putter(none.deps)("ol_123", BODY), 409, "entitlement_closed");
  assert.deepEqual(writes, ["update"]);
  assert.deepEqual(none.writes, ["update"]);
});

test("PUT: seats below the assigned count is 409 with seatsAssigned, also when the guard refuses the write", async () => {
  const { deps, writes } = store([stored({ SeatsAssigned: 9 })]);
  const below = await assertError(await putter(deps)("ol_123", { ...BODY, seats: 8 }), 409, "seats_below_assigned");
  assert.equal(below.seatsAssigned, 9);
  assert.deepEqual(writes, [], "the stored count already refuses it");

  // Assignments land between the read and the write: the guard changes nothing twice.
  const raced = store([stored({ SeatsAssigned: 9 })]);
  let assigned = 9;
  const race: EntitlementPutDeps = {
    ...raced.deps,
    findEntitlement: async (id) => {
      const row = await raced.deps.findEntitlement(id);
      return row && { ...row, SeatsAssigned: assigned };
    },
    updateEntitlement: async () => {
      raced.writes.push("update");
      assigned = 12;
      return false;
    },
  };
  const res = await assertError(await putter(race)("ol_123", { ...BODY, seats: 10 }), 409, "seats_below_assigned");
  assert.equal(res.seatsAssigned, 12);
  assert.deepEqual(raced.writes, ["update"], "the fresh read refuses before a second write");
});

test("PUT: a guarded UPDATE that loses to a close is decided again on the closed row", async () => {
  const { deps, byLine } = store([stored({ SeatsAssigned: 0 })]);
  const race: EntitlementPutDeps = {
    ...deps,
    updateEntitlement: async (change) => {
      Object.assign(byLine.get("ol_123")!, { Seats: 0, Status: "closed" });
      return deps.updateEntitlement(change);
    },
  };
  await assertError(await putter(race)("ol_123", { ...BODY, seats: 5 }), 409, "entitlement_closed");
});

test("GET: the entitlement, 404 entitlement_not_found, or 400 for a malformed id", async () => {
  const { deps } = store([stored()]);
  const get = createEntitlementGetHandler(deps);
  const found = await get(new Request(url("ol_123")), ctx("ol_123"));
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), toEntitlementBody(stored()));
  await assertError(await get(new Request(url("ol_999")), ctx("ol_999")), 404, "entitlement_not_found");
  await assertError(await get(new Request(url("ol/1")), ctx("ol/1")), 400, "invalid_request");
});

test("PUT and GET: a tenant lms_ key, or a token without Entitlements.Write, is refused by the real gate", async () => {
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
  const authenticate = (req: Request) =>
    requireMarketplaceCaller(req, "Marketplace.Entitlements.Write", {
      env: { AZURE_AD_CLIENT_ID: CLIENT, MARKETPLACE_CALLER_APP_ID: CALLER },
      fetchJwks: async () => ({ keys: [{ ...keys.publicKey.export({ format: "jwk" }), kid: "k1", use: "sig" }] }),
      now: () => now,
    });
  const { deps } = store([stored()]);
  const put = createEntitlementPutHandler({ ...deps, authenticate });
  const get = createEntitlementGetHandler({ ...deps, authenticate });
  const req = (authorization: string, method = "GET") =>
    new Request(url("ol_123"), { method, headers: { authorization }, ...(method === "PUT" ? { body: JSON.stringify(BODY) } : {}) });

  await assertError(await put(req("Bearer lms_abc_def", "PUT"), ctx("ol_123")), 401, "invalid_token", "PUT, lms_ key");
  await assertError(await get(req("Bearer lms_abc_def"), ctx("ol_123")), 401, "invalid_token", "GET, lms_ key");
  const readOnly = `Bearer ${token(["Marketplace.Catalogue.Read", "Marketplace.Usage.Read"])}`;
  await assertError(await put(req(readOnly, "PUT"), ctx("ol_123")), 403, "insufficient_scope", "PUT, read roles only");
  await assertError(await get(req(readOnly), ctx("ol_123")), 403, "insufficient_scope", "GET, read roles only");
  const write = `Bearer ${token(["Marketplace.Entitlements.Write"])}`;
  assert.equal((await put(req(write, "PUT"), ctx("ol_123"))).status, 200);
  assert.equal((await get(req(write), ctx("ol_123"))).status, 200);
});

// ---- plumbing --------------------------------------------------------------

const ROUTE = "app/api/v1/marketplace/entitlements/[orderLineId]/route.ts";
const source = (path: string) => readFileSync(new URL(path, ROOT), "utf8");

test("PUT and GET are logged by withApiLogging and gated on Marketplace.Entitlements.Write", () => {
  const route = source(ROUTE);
  assert.match(route, /const authenticate = \(req: Request\) => requireMarketplaceCaller\(req, "Marketplace\.Entitlements\.Write"\);/);
  assert.match(route, /export const PUT = withApiLogging\("marketplace_put_entitlement", createEntitlementPutHandler\(\{\s+authenticate,/);
  assert.match(route, /export const GET = withApiLogging\("marketplace_get_entitlement", createEntitlementGetHandler\(\{\s+authenticate,/);
  assert.equal(route.match(/requireMarketplaceCaller\(/g)?.length, 1);
  assert.doesNotMatch(route, /requireApiKey|lib\/api\/bearer/, "a tenant key must never reach seat intake");
});

test("the entitlement route needs no cookie session and stays out of /api/openapi.json", () => {
  const on = (paths: string[] | undefined, path: string) => (paths ?? []).some((p) => path === p || path.startsWith(`${p}/`));
  const path = "/api/v1/marketplace/entitlements/ol_123";
  assert.ok(on(authConfig.publicPaths, path), path);
  assert.ok(!on(authConfig.staffPaths, path), path);
  assert.doesNotMatch(source("app/api/openapi.json/route.ts"), /marketplace/i);
});
