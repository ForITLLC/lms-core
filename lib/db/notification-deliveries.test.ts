import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";

function load(db: { query: (...args: any[]) => Promise<any[]>; queryOne?: (...args: any[]) => Promise<any> }) {
  const exports: any = {};
  const code = ts.transpileModule(readFileSync(new URL("./notification-deliveries.ts", import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(code, { exports, Date, require: (name: string) => {
    assert.equal(name, "@/lib/db");
    return db;
  } });
  return exports;
}

const start = new Date("2026-10-24T15:45:00.000Z");
const end = new Date("2026-10-24T16:05:00.000Z");
const filter = { recipient: "learner@example.test", start, end, limit: 2 };
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
function delivery(claim: string, over: Record<string, unknown> = {}) {
  return { DigestDay: "2026-10-24", ClaimId: claim, Status: "sent", WindowStart: start,
    WindowEnd: end, ClaimedAt: start, SentAt: end, HasError: false, ...over };
}
function run(message: string, over: Record<string, unknown> = {}) {
  return { RunTimestamp: start, Status: "SUCCESS", DurationMs: 25, ItemsProcessed: 1,
    Message: message, ...over };
}

test("actor authorization is bound to both tenant and API-key owner, not a recipient claim", async () => {
  let actor: any = null;
  const db = load({ query: async () => { throw new Error("Unexpected query"); },
    queryOne: async (sql: string, params: any) => {
      assert.match(sql, /TenantId\s*=\s*@tenantId/);
      assert.match(sql, /AppUserId\s*=\s*@appUserId/);
      assert.deepEqual(plain(params), { tenantId: "tenant-A", appUserId: "user-A" });
      assert.doesNotMatch(sql, /learner@example/);
      return actor;
    },
  });
  const read = () => db.authorizeNotificationDeliveryRead("tenant-A", "user-A", filter.recipient);
  assert.deepEqual(plain(await read()), { admin: false, self: false, allowed: false });
  actor = { Email: " LEARNER@EXAMPLE.TEST ", Role: "author" };
  assert.deepEqual(plain(await read()), { admin: false, self: true, allowed: true });
  actor = { Email: "other@example.test", Role: "author" };
  assert.deepEqual(plain(await read()), { admin: false, self: false, allowed: false });
  actor.Role = "manager";
  assert.equal((await read()).allowed, false);
  actor.Role = "admin";
  assert.deepEqual(plain(await read()), { admin: true, self: false, allowed: true });
  actor.Email = "learner@example.test";
  assert.deepEqual(plain(await read()), { admin: true, self: true, allowed: true });
});

test("ledger query keeps tenant/recipient parameters, UTC endpoints and row bounds separate from SQL", async () => {
  const cases = [
    { ...delivery("at-start"), tenant: "tenant-A", recipient: filter.recipient },
    { ...delivery("sent-at-start", { ClaimedAt: new Date(start.getTime() - 1), SentAt: start }), tenant: "tenant-A", recipient: filter.recipient },
    { ...delivery("at-exclusive-end", { ClaimedAt: end, SentAt: null }), tenant: "tenant-A", recipient: filter.recipient },
    { ...delivery("before-start", { ClaimedAt: new Date(start.getTime() - 1), SentAt: null }), tenant: "tenant-A", recipient: filter.recipient },
    { ...delivery("foreign-tenant"), tenant: "tenant-B", recipient: filter.recipient },
    { ...delivery("foreign-recipient"), tenant: "tenant-A", recipient: "other@example.test" },
  ];
  const db = load({ query: async (sql: string, params: any) => {
    assert.match(sql, /TenantId\s*=\s*@tenantId\s+AND\s+RecipientEmail\s*=\s*@recipient/);
    assert.match(sql, /ClaimedAt\s*>=\s*@start\s+AND\s+ClaimedAt\s*<\s*@end/);
    assert.match(sql, /SentAt\s*>=\s*@start\s+AND\s+SentAt\s*<\s*@end/);
    assert.match(sql, /TOP\s*\(@take\)/i);
    assert.doesNotMatch(sql, /learner@example\.test|tenant-A/);
    assert.equal(params.tenantId, "tenant-A");
    assert.equal(params.recipient, filter.recipient);
    assert.equal(params.start, start);
    assert.equal(params.end, end);
    assert.equal(params.take, 3);
    const inside = (date: Date | null) => date !== null && date >= params.start && date < params.end;
    return cases.filter(row => row.tenant === params.tenantId && row.recipient === params.recipient
      && (inside(row.ClaimedAt) || inside(row.SentAt))).slice(0, params.take);
  } });
  const result = await db.readNotificationDeliveries("tenant-A", filter, { includeServiceRuns: false });
  assert.deepEqual(plain(result.deliveries.map((row: any) => row.claimId)), ["at-start", "sent-at-start"]);
  assert.equal(result.truncated, false);
  assert.doesNotMatch(JSON.stringify(result), /foreign-|exclusive-end|before-start/);
});

test("ledger returns only the requested page and never projects stored provider/error text", async () => {
  const db = load({ query: async (_sql: string, params: any) => {
    assert.equal(params.take, 3);
    return [delivery("one", { Status: "uncertain", HasError: true,
      Error: "RAW PROVIDER SECRET other-tenant@example.test", RecipientEmail: "other-tenant@example.test" }),
    delivery("two", { Status: "claimed", SentAt: null }), delivery("overflow")];
  }, queryOne: async () => { throw new Error("Self read must not inspect shared logs"); } });
  const result = await db.readNotificationDeliveries("tenant-A", filter, { includeServiceRuns: false });
  assert.equal(result.truncated, true);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.deliveries[0].hasError, true);
  assert.equal(result.deliveries[0].recipientEmail, filter.recipient);
  assert.equal(result.deliveries[1].sentAt, null);
  assert.equal(result.service_runs_coverage, "insufficient_role");
  assert.deepEqual(plain(result.service_runs), []);
  assert.doesNotMatch(JSON.stringify(result), /RAW PROVIDER|other-tenant|overflow/);
});

test("admin logs use the DB-resolved exact tenant prefix and expose only parsed aggregate fields", async () => {
  const foreign = run("tenant=tenant-one-extra sent=1 skipped=0 held=0");
  const injected = run("tenant=tenant-one sent=1 skipped=0 held=0 raw user=private@example.test");
  let reads = 0;
  const db = load({
    queryOne: async (sql: string, params: any) => {
      assert.match(sql, /FROM lms\.Tenant WHERE TenantId = @tenantId/);
      assert.equal(params.tenantId, "tenant-A");
      return { Slug: "tenant-one" };
    },
    query: async (sql: string, params: any) => {
      reads++;
      if (sql.includes("lms.DigestDelivery")) return [];
      assert.match(sql, /FROM logging\.ServiceHealth/);
      assert.match(sql, /ServiceName\s*=\s*@serviceName/);
      assert.match(sql, /RunTimestamp\s*>=\s*@start\s+AND\s+RunTimestamp\s*<\s*@end/);
      assert.match(sql, /LEFT\(Message,/);
      assert.match(sql, /LEN\(@prefix\s*\+\s*N?'#'\)\s*-\s*1/);
      assert.doesNotMatch(sql, /LIKE|logging\.Errors|private@example|tenant-one/);
      assert.equal(params.serviceName, "lms-daily-digest");
      assert.equal(params.prefix, "tenant=tenant-one ");
      assert.equal(params.start, start);
      assert.equal(params.end, end);
      assert.equal(params.take, 5);
      // Include hostile rows as defense-in-depth input, even though the SQL boundary must exclude foreign prefixes.
      return [run("tenant=tenant-one sent=1 skipped=2 held=0"), foreign, injected];
    },
  });
  const result = await db.readNotificationDeliveries("tenant-A", { ...filter, limit: 4 }, { includeServiceRuns: true });
  assert.equal(reads, 2);
  assert.equal(result.service_runs_coverage, "partial_unparseable");
  assert.equal(result.service_runs.length, 1);
  assert.deepEqual(plain(result.service_runs[0]), {
    runTimestamp: start.toISOString(), status: "SUCCESS", durationMs: 25, itemsProcessed: 1,
    sent: 1, skipped: 2, held: 0,
  });
  assert.doesNotMatch(JSON.stringify(result), /Message|tenant-one-extra|private@example/);
});

test("service log counter, status and whole-message validation fails closed on ambiguous records", async () => {
  const invalid = [
    run("ignored", { Message: null }),
    run("ignored", { Message: 42 }),
    run("tenant=t sent=1 skipped=0 held=0 trailing-secret"),
    run("tenant=t sent=1 skipped=0 held=0\n"),
    run("tenant=t sent=1 skipped=0 held=0\r\n"),
    run("tenant=t-other sent=1 skipped=0 held=0"),
    run("tenant=tXsent=1 skipped=0 held=0"),
    run("tenant=t sent=01 skipped=0 held=0"),
    run("tenant=t sent=-1 skipped=0 held=0"),
    run("tenant=t sent=9007199254740992 skipped=0 held=0", { ItemsProcessed: 9007199254740992 }),
    run("tenant=t sent=1 skipped=0 held=0", { ItemsProcessed: 2 }),
    run("tenant=t sent=1 skipped=0 held=1"),
    run("tenant=t sent=1 skipped=0 held=0", { Status: "FAILURE" }),
    run("tenant=t sent=1 skipped=0 held=0", { DurationMs: -1 }),
    run("tenant=t sent=1 skipped=0 held=0", { DurationMs: 1.2 }),
    run("tenant=t summary failed", { Status: "SUCCESS", ItemsProcessed: 0 }),
    run("tenant=t summary failed: raw SQL exception", { Status: "FAILURE", ItemsProcessed: 0 }),
  ];
  const db = load({ queryOne: async () => ({ Slug: "t" }), query: async sql =>
    sql.includes("lms.DigestDelivery") ? [] : invalid });
  const result = await db.readNotificationDeliveries("tenant-A", { ...filter, limit: 100 }, { includeServiceRuns: true });
  assert.equal(result.service_runs.length, 0);
  assert.equal(result.service_runs_coverage, "partial_unparseable");
  assert.doesNotMatch(JSON.stringify(result), /secret|SQL exception/);
});

test("known summary failures preserve unknown counters and service-log row caps remain explicit", async () => {
  const rows = [run("tenant=t summary failed", { Status: "FAILURE", ItemsProcessed: 0, DurationMs: null }),
    run("tenant=t sent=1 skipped=0 held=2", { Status: "FAILURE" }), run("tenant=t sent=1 skipped=0 held=0")];
  const db = load({ queryOne: async () => ({ Slug: "t" }), query: async sql =>
    sql.includes("lms.DigestDelivery") ? [] : rows });
  const result = await db.readNotificationDeliveries("tenant-A", filter, { includeServiceRuns: true });
  assert.equal(result.service_runs.length, 2);
  assert.equal(result.service_runs_truncated, true);
  assert.equal(result.service_runs[0].sent, null);
  assert.equal(result.service_runs[0].held, null);
  assert.equal(result.service_runs[1].held, 2);
});

test("shared log failure preserves available ledger evidence without inventing log absence", async () => {
  const db = load({ queryOne: async () => ({ Slug: "t" }), query: async sql => {
    if (sql.includes("lms.DigestDelivery")) return [delivery("real-ledger-row")];
    throw new Error("Shared provider SQL password=secret");
  } });
  const result = await db.readNotificationDeliveries("tenant-A", filter, { includeServiceRuns: true });
  assert.equal(result.deliveries.length, 1);
  assert.equal(result.service_runs_coverage, "backend_read_failed");
  assert.deepEqual(plain(result.service_runs), []);
  assert.doesNotMatch(JSON.stringify(result), /password|secret/);
});
