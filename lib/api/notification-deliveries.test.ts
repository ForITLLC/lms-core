import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createNotificationDeliveriesHandler, parseNotificationDeliveryQuery } from "./notification-deliveries";

const recipient = "learner@example.test";
const start = "2026-10-24T15:45:00Z";
const end = "2026-10-24T16:05:00Z";
const valid = { recipient, start, end };
const parse = (values: Record<string, string>) => parseNotificationDeliveryQuery(new URLSearchParams(values));

test("diagnostic query normalizes recipient and uses exact half-open UTC boundaries", () => {
  const result = parse({ ...valid, recipient: " Learner+Daily@Example.Test ", limit: "100" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.recipient, "learner+daily@example.test");
  assert.equal(result.value.limit, 100);
  assert.equal(result.value.start.toISOString(), "2026-10-24T15:45:00.000Z");
  assert.equal(result.value.end.toISOString(), "2026-10-24T16:05:00.000Z");
  const defaults = parse(valid);
  assert.ok(defaults.ok);
  assert.equal(defaults.value.limit, 50);
});

test("UTC day includes a leap day and midnight rollovers without local-time conversion", () => {
  for (const [day, expectedEnd] of [["2028-02-29", "2028-03-01"], ["2026-12-31", "2027-01-01"]]) {
    const result = parse({ recipient, day: day! });
    assert.ok(result.ok);
    assert.equal(result.value.start.toISOString(), `${day}T00:00:00.000Z`);
    assert.equal(result.value.end.toISOString(), `${expectedEnd}T00:00:00.000Z`);
  }
});

test("malformed recipient, calendar, interval and row limits fail before data access", () => {
  const invalid: Array<[string, Record<string, string>]> = [
    ["missing recipient", { start, end }],
    ["recipient without domain", { ...valid, recipient: "learner" }],
    ["multiple address separators", { ...valid, recipient: "a@example.test@other.test" }],
    ["recipient line injection", { ...valid, recipient: "a@example.test\r\nBcc:other@example.test" }],
    ["non-ASCII recipient", { ...valid, recipient: "学習@example.test" }],
    ["empty local-part segment", { ...valid, recipient: "a..b@example.test" }],
    ["empty domain segment", { ...valid, recipient: "a@example..test" }],
    ["oversized recipient", { ...valid, recipient: `${"a".repeat(310)}@example.test` }],
    ["missing start", { recipient, end }],
    ["missing end", { recipient, start }],
    ["calendar overflow", { ...valid, start: "2026-02-30T00:00:00Z", end: "2026-03-03T00:00:00Z" }],
    ["invalid hour", { ...valid, start: "2026-10-24T24:00:00Z", end: "2026-10-25T01:00:00Z" }],
    ["non-UTC offset", { ...valid, start: "2026-10-24T15:45:00+00:00" }],
    ["implicit timezone", { ...valid, start: "2026-10-24T15:45:00" }],
    ["fraction precision", { ...valid, start: "2026-10-24T15:45:00.1234Z" }],
    ["equal endpoints", { ...valid, end: start }],
    ["reversed endpoints", { ...valid, start: end, end: start }],
    ["over24hours", { ...valid, start: "2026-10-24T00:00:00Z", end: "2026-10-25T00:00:00.001Z" }],
    ["invalid UTC day", { recipient, day: "2026-02-29" }],
    ["year zero outside SQL range", { recipient, day: "0000-01-01" }],
    ["day exceeds SQL end bound", { recipient, day: "9999-12-31" }],
    ["mixed day/interval", { ...valid, day: "2026-10-24" }],
    ...["0", "-1", "101", "1.5", "1e2", "", " 1", "1\n"].map((limit): [string, Record<string, string>] => [`limit${limit}`, { ...valid, limit }]),
  ];
  for (const [name, values] of invalid) assert.equal(parse(values).ok, false, name);
  assert.equal(parse({ ...valid, start: "2026-10-24T00:00:00Z", end: "2026-10-25T00:00:00Z" }).ok, true);
  assert.equal(parse({ ...valid, limit: "1" }).ok, true);
});

test("repeated or unknown parameters cannot select another tenant or hide conflicting bounds", () => {
  for (const name of ["recipient", "start", "end", "limit", "day"]) {
    const params = new URLSearchParams(name === "day" ? { recipient, day: "2026-10-24" } : valid);
    if (name === "limit") params.set("limit", "50");
    params.append(name, params.get(name) ?? "50");
    assert.equal(parseNotificationDeliveryQuery(params).ok, false, name);
  }
  for (const name of ["tenantId", "tenant", "recipientEmail", "includeErrors", "offset"]) {
    assert.equal(parse({ ...valid, [name]: "other-tenant" }).ok, false, name);
  }
});

function realBearerGate() {
  const exports: any = {};
  const modules: Record<string, unknown> = {
    "next/server": { NextResponse: Response },
    "@/lib/db/apiKeys": { authenticateApiKey: async (key: string) =>
      key === "lms_valid" ? { tenantId: "tenant-A", appUserId: "user-A" } : null },
  };
  const code = ts.transpileModule(readFileSync(new URL("./bearer.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, Response, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
    return modules[name];
  } });
  return exports.requireApiKey;
}

function request(values: Record<string, string> = valid, authorization = "Bearer lms_valid") {
  return new Request(`https://tenant.example.test/api/v1/notification-deliveries?${new URLSearchParams(values)}`,
    { headers: authorization ? { authorization } : {} });
}

test("actual bearer gate rejects absent, malformed and revoked keys before parsing or reading", async () => {
  let accesses = 0;
  const handler = createNotificationDeliveriesHandler({
    authenticate: realBearerGate(),
    authorize: async () => { accesses++; return { allowed: true, admin: true }; },
    read: async () => { accesses++; throw new Error("Data must not be touched"); },
    recordUnavailable: async () => { accesses++; },
  });
  for (const header of ["", "Basic lms_valid", "Bearer", "Bearer lms_revoked"]) {
    const response = await handler(request({ recipient: "malformed" }, header));
    assert.equal(response.status, 401, header);
    assert.match(response.headers.get("www-authenticate") ?? "", /Bearer/);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }
  assert.equal(accesses, 0);
});

test("authenticated actor scope controls reads and empty results remain partial evidence", async () => {
  const calls: any[] = [];
  const handler = createNotificationDeliveriesHandler({
    authenticate: realBearerGate(),
    authorize: async (...args) => { calls.push(["authorize", ...args]); return { allowed: true, admin: false }; },
    read: async (...args) => { calls.push(["read", ...args]); return {
      deliveries: [], truncated: false, service_runs: [], service_runs_truncated: false,
      service_runs_coverage: "insufficient_role",
    }; },
    recordUnavailable: async () => { throw new Error("Not expected"); },
  });
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  const body = await response.json();
  assert.equal(body.tenantId, "tenant-A");
  assert.equal(body.recipient, recipient);
  assert.equal(body.coverage.state, "partial");
  assert.deepEqual(body.errors, []);
  assert.match(body.interpretation, /not mailbox delivery/i);
  assert.match(body.interpretation, /[Ee]mpty results do not prove/);
  assert.equal(body.coverage.service_runs, "insufficient_role");
  assert.equal(body.coverage.errors, "not_tenant_correlatable");
  assert.equal(body.coverage.mailbox_delivery, "not_observed");
  assert.equal(body.coverage.apns, "not_instrumented");
  assert.equal(body.coverage.native_local_notifications, "not_observed");
  assert.equal(calls[0][1], "tenant-A");
  assert.equal(calls[0][2], "user-A");
  assert.equal(calls[0][3], recipient);
  assert.equal(calls[1][1], "tenant-A");
  assert.equal(calls[1][2].recipient, recipient);
  assert.deepEqual(calls[1][3], { includeServiceRuns: false });
});

test("another recipient is refused without a data query when caller lacks authorization", async () => {
  let reads = 0;
  const handler = createNotificationDeliveriesHandler({
    authenticate: realBearerGate(), authorize: async () => ({ allowed: false, admin: false }),
    read: async () => { reads++; throw new Error("Must not query"); }, recordUnavailable: async () => {},
  });
  assert.equal((await handler(request({ ...valid, recipient: "other@example.test" }))).status, 403);
  assert.equal(reads, 0);
});

test("admin aggregate access preserves row caps and never labels a sent claim as delivered", async () => {
  const handler = createNotificationDeliveriesHandler({
    authenticate: realBearerGate(), authorize: async () => ({ allowed: true, admin: true }),
    read: async (tenantId, receivedFilter, options) => {
      assert.equal(tenantId, "tenant-A");
      assert.equal(receivedFilter.recipient, "other@example.test");
      assert.equal(options.includeServiceRuns, true);
      return { deliveries: [{ tenantId, recipientEmail: receivedFilter.recipient, digestDay: "2026-10-24",
        claimId: "claim-A", status: "sent", windowStart: start, windowEnd: end, claimedAt: start,
        sentAt: end, hasError: false }], truncated: true, service_runs: [],
      service_runs_truncated: true, service_runs_coverage: "available" };
    }, recordUnavailable: async () => {},
  });
  const response = await handler(request({ ...valid, recipient: "other@example.test" }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deliveries[0].status, "sent");
  assert.equal(body.deliveries[0].deliveredAt, undefined);
  assert.equal(body.truncated, true);
  assert.equal(body.service_runs_truncated, true);
  assert.equal(body.coverage.service_runs, "available");
  assert.equal(body.coverage.mailbox_delivery, "not_observed");
  assert.match(body.interpretation, /sent means transport accepted.*not mailbox delivery/i);
  assert.match(body.interpretation, /tenant aggregates, not recipient delivery proof/);
});

test("authentication storage failure is unavailable evidence, never invalid-token or leaked provider detail", async () => {
  let touched = 0;
  let logged = 0;
  const handler = createNotificationDeliveriesHandler({
    authenticate: async () => { throw new Error("authentication SQL_SECRET and private@example.test"); },
    authorize: async () => { touched++; return { allowed: true, admin: true }; },
    read: async () => { touched++; throw new Error("Must not read"); },
    recordUnavailable: async () => { logged++; throw new Error("Logger failed too"); },
  });
  const response = await handler(request());
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /SQL_SECRET|private@example|Logger failed|invalid_token/);
  assert.equal(touched, 0);
  assert.equal(logged, 1);
});

test("invalid filters cannot query storage and unavailable data never leaks provider details", async () => {
  let reads = 0;
  let recorded = 0;
  const handler = createNotificationDeliveriesHandler({
    authenticate: realBearerGate(), authorize: async () => ({ allowed: true, admin: true }),
    read: async () => { reads++; throw new Error("SQL_PASSWORD=secret raw recipient outside-tenant@example.test"); },
    recordUnavailable: async () => { recorded++; throw new Error("Logging also unavailable"); },
  });
  assert.equal((await handler(request({ ...valid, limit: "101" }))).status, 400);
  assert.equal(reads, 0);
  const response = await handler(request());
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.doesNotMatch(text, /SQL_PASSWORD|outside-tenant|Logging also unavailable/);
  assert.equal(reads, 1);
  assert.equal(recorded, 1);
});
