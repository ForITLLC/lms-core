import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLearningSummaryFeedHandler, parseLearningSummaryQuery, type LearningSummaryFeedDeps } from "./learning-summary-feed";
import { emptySummarySection, type LearningSummary, type SummaryItem } from "../learning-summary";

const item: SummaryItem = { id: "1", learner_id: "L", learner_name: "Pat", learner_email: "pat@example.test", course_id: "C", course_slug: "safety",
  course_title: "Safety", due_date: "2026-11-01T00:00:00Z", occurred_at: null };
const summary: LearningSummary = { generated_at: "2026-10-29T14:00:00Z", window_start: "2026-10-28T14:00:00Z",
  personal: { ...emptySummarySection(), due: [item], overdue: [item, item] }, team: null };

function handler(overrides: Partial<LearningSummaryFeedDeps> = {}) {
  const calls = { authorize: [] as unknown[][], read: [] as unknown[][], unavailable: 0 };
  const deps: LearningSummaryFeedDeps = {
    authenticate: async () => ({ ok: true, ctx: { tenantId: "T", appUserId: "U", ownerOnly: false } }),
    authorize: async (...args) => { calls.authorize.push(args); return { allowed: true, self: false }; },
    read: async (...args) => { calls.read.push(args); return { summary, summaryUrl: "https://operator.example.test/dashboard/summary" }; },
    recordUnavailable: async () => { calls.unavailable++; },
    ...overrides,
  };
  return { GET: createLearningSummaryFeedHandler(deps), calls };
}

const get = (query: string) => new Request(`https://operator.example.test/api/v1/learning-summary${query}`, { headers: { authorization: "Bearer lms_x_y" } });

test("recipient is trimmed and lowercased; anything else in the query is refused", () => {
  assert.deepEqual(parseLearningSummaryQuery(new URLSearchParams({ recipient: " Pat@Example.Test " })), { ok: true, recipient: "pat@example.test" });
  for (const query of ["", "recipient=pat", "recipient=a@b.test&recipient=c@d.test", "recipient=a@b.test&tenant=other", "email=a@b.test", `recipient=${"a".repeat(320)}@b.test`])
    assert.equal(parseLearningSummaryQuery(new URLSearchParams(query)).ok, false, query);
});

test("the key's tenant and the normalized recipient go to the read; counts match the sections", async () => {
  const app = handler();
  const response = await app.GET(get("?recipient=Pat@Example.Test"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(app.calls.authorize, [["T", "U", "pat@example.test"]]);
  assert.deepEqual(app.calls.read, [["T", "pat@example.test"]]);
  const body = await response.json();
  assert.equal(body.recipient, "pat@example.test");
  assert.equal(body.summary_url, "https://operator.example.test/dashboard/summary");
  assert.deepEqual(body.counts, { personal: { overdue: 2, due: 1, completions: 0, new_assignments: 0 }, team: null });
  assert.equal(body.personal.due[0].course_title, "Safety");
  assert.equal(body.team, null);
});

test("an unauthenticated call stops at the key check", async () => {
  const denied = new Response("no", { status: 401 });
  const app = handler({ authenticate: async () => ({ ok: false, response: denied as never }) });
  assert.equal((await app.GET(get("?recipient=pat@example.test"))).status, 401);
  assert.equal(app.calls.authorize.length + app.calls.read.length, 0);
});

test("a bad query is refused before authorization or any read", async () => {
  const app = handler();
  assert.equal((await app.GET(get("?recipient=pat@example.test&tenant=other"))).status, 400);
  assert.equal(app.calls.authorize.length + app.calls.read.length, 0);
});

test("a key that is neither a tenant admin's nor the recipient's own reads nothing", async () => {
  const app = handler({ authorize: async () => ({ allowed: false, self: false }) });
  const response = await app.GET(get("?recipient=pat@example.test"));
  assert.equal(response.status, 403);
  assert.equal(app.calls.read.length, 0);
});

const ownerOnlyKey = { authenticate: async () => ({ ok: true as const, ctx: { tenantId: "T", appUserId: "U", ownerOnly: true } }) };

test("an owner-only key reads its owner's own summary", async () => {
  const app = handler({ ...ownerOnlyKey, authorize: async () => ({ allowed: true, self: true }) });
  assert.equal((await app.GET(get("?recipient=pat@example.test"))).status, 200);
  assert.deepEqual(app.calls.read, [["T", "pat@example.test"]]);
});

test("an owner-only key reads nobody else's summary, even when its owner is a tenant admin", async () => {
  const app = handler({ ...ownerOnlyKey, authorize: async () => ({ allowed: true, self: false }) });
  const response = await app.GET(get("?recipient=someone.else@example.test"));
  assert.equal(response.status, 403);
  assert.match((await response.json()).error_description, /only its owner's own summary/);
  assert.equal(app.calls.read.length, 0);
});

test("a failed read answers a generic 503 with no SQL text", async () => {
  const app = handler({ read: async () => { throw new Error("SQL secret details"); } });
  const response = await app.GET(get("?recipient=pat@example.test"));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /SQL secret/);
  assert.equal(app.calls.unavailable, 1);
});

test("the route wires the bearer key, the admin-or-self check and the tenant-scoped read", () => {
  const route = readFileSync(new URL("../../app/api/v1/learning-summary/route.ts", import.meta.url), "utf8");
  for (const wiring of [/authenticate: \(req\) => requireApiKey\(req, \{ allowOwnerOnly: true \}\)/, /authorize: authorizeNotificationDeliveryRead/, /read: readLearningSummaryFeed/]) assert.match(route, wiring);
  const read = readFileSync(new URL("../db/learning-summary-feed.ts", import.meta.url), "utf8");
  assert.match(read, /WHERE TenantId = @tenantId/);
  assert.match(read, /getLearningSummary\(tenantId, recipient\)/);
});
