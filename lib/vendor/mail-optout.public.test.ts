import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  createMemoryOptOutStore,
  createSqlOptOutStore,
  createUnsubscribeKeyring,
  createUnsubscribeRouteHandler,
  subjectForAddress,
  unsubscribeLink,
  verifyUnsubscribeToken,
  type OptOutDb,
  type OptOutSqlParam,
  type OptOutStore,
  type OptOutSubject,
  type UnsubscribeErrorContext,
  type UnsubscribeKeyring,
  type UnsubscribeRouteOptions,
} from "./mail-optout.public";

// Token wire format, carried as the one query parameter `t` (every character is URL-safe):
//
//   v1.<kid>.<payload>.<signature>
//   payload   = base64url(UTF-8 JSON [purpose, tenant, subject, category, day])
//   signature = base64url(HMAC-SHA256(keys[kid], "v1.<kid>.<payload>")), 43 characters, no padding
//   day       = whole UTC days since 1970-01-01 at mint; the link verifies until maxAgeDays
//               (default 180, never below 60) after that day, and at most one day ahead
//
// The keyring's current key signs; every key in the ring verifies, so a new key can be made
// current while links signed with the old one keep working until it is removed.

const DAY_MS = 86_400_000;
const OLD = "o".repeat(40);
const NEW = "n".repeat(40);
const PEPPER = "p".repeat(40);
const PURPOSE = "app-mail";
const CATEGORY = "weekly-report";
const BASE = "https://learn.example.test/api/unsubscribe";
const NOW = Date.UTC(2026, 0, 15, 12);
const DAY = Math.floor(NOW / DAY_MS);
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

const ring = createUnsubscribeKeyring({ current: "k1", keys: { k1: OLD } });
const pat: OptOutSubject = { tenant: "tenant-a", subject: subjectForAddress("tenant-a", "pat@example.test", PEPPER) };
const sam: OptOutSubject = { tenant: "tenant-a", subject: subjectForAddress("tenant-a", "sam@example.test", PEPPER) };

function linkFor(who = pat, category = CATEGORY, keyring: UnsubscribeKeyring = ring, purpose = PURPOSE, now = NOW): string {
  const link = unsubscribeLink({ baseUrl: BASE, keyring, purpose, who, category, now });
  assert.ok(link);
  return link.url;
}

function tokenOf(url: string): string {
  const token = new URL(url).searchParams.get("t");
  assert.ok(token);
  return token;
}

function partsOf(token: string): [string, string, string, string] {
  const parts = token.split(".");
  assert.equal(parts.length, 4);
  return parts as [string, string, string, string];
}

function verify(token: unknown, keyring: UnsubscribeKeyring = ring, extra: { maxAgeDays?: number; now?: number } = {}) {
  return verifyUnsubscribeToken(token, { keyring, purpose: PURPOSE, now: NOW, ...extra });
}

/** A correctly signed token over any payload, to test what the verifier checks after the signature. */
function signedToken(fields: unknown, secret = OLD, kid = "k1"): string {
  const payload = Buffer.from(JSON.stringify(fields), "utf8").toString("base64url");
  return `v1.${kid}.${payload}.${createHmac("sha256", secret).update(`v1.${kid}.${payload}`).digest("base64url")}`;
}

test("wire format: v1.<kid>.<base64url JSON>.<HMAC-SHA256>, URL-safe, with no address in it", () => {
  const url = linkFor();
  const token = tokenOf(url);
  assert.equal(url, `${BASE}?t=${token}`);
  assert.equal(encodeURIComponent(token), token);
  const [version, kid, payload, signature] = partsOf(token);
  assert.equal(version, "v1");
  assert.equal(kid, "k1");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")), [PURPOSE, "tenant-a", pat.subject, CATEGORY, DAY]);
  assert.equal(signature, createHmac("sha256", OLD).update(`v1.k1.${payload}`).digest("base64url"));
  assert.equal(token, signedToken([PURPOSE, "tenant-a", pat.subject, CATEGORY, DAY]));
  assert.doesNotMatch(Buffer.from(payload, "base64url").toString("utf8"), /pat|example/);
});

test("round trip: a link verifies to exactly the tenant, subject and category it was minted for", () => {
  assert.deepEqual(verify(tokenOf(linkFor())), { ok: true, who: pat, category: CATEGORY, mintedDay: DAY });
  assert.deepEqual(verify(tokenOf(linkFor(sam, "a-digest"))), { ok: true, who: sam, category: "a-digest", mintedDay: DAY });
});

test("rotation: the current key signs, every key in the ring verifies, a removed or replaced key does not", () => {
  const oldToken = tokenOf(linkFor());
  const rotated = createUnsubscribeKeyring({ current: "k2", keys: { k1: OLD, k2: NEW } });
  const newToken = tokenOf(linkFor(pat, CATEGORY, rotated));
  assert.equal(partsOf(newToken)[1], "k2");
  assert.equal(verify(oldToken, rotated).ok, true);
  assert.equal(verify(newToken, rotated).ok, true);
  const retired = createUnsubscribeKeyring({ current: "k2", keys: { k2: NEW } });
  assert.deepEqual(verify(oldToken, retired), { ok: false, reason: "unknown-key" });
  assert.deepEqual(verify(newToken, ring), { ok: false, reason: "unknown-key" });
  assert.deepEqual(verify(oldToken, createUnsubscribeKeyring({ current: "k1", keys: { k1: NEW } })), { ok: false, reason: "bad-signature" });
});

test("tampering is refused: another tenant, subject, category, purpose or day under the old signature, an edited signature or kid", () => {
  const token = tokenOf(linkFor());
  const [version, kid, payload, signature] = partsOf(token);
  const swap = (fields: unknown[]) => `${version}.${kid}.${Buffer.from(JSON.stringify(fields)).toString("base64url")}.${signature}`;
  for (const fields of [
    [PURPOSE, "tenant-b", pat.subject, CATEGORY, DAY],
    [PURPOSE, "tenant-a", sam.subject, CATEGORY, DAY],
    [PURPOSE, "tenant-a", pat.subject, "other-mail", DAY],
    ["other-purpose", "tenant-a", pat.subject, CATEGORY, DAY],
    [PURPOSE, "tenant-a", pat.subject, CATEGORY, DAY + 365],
  ]) {
    assert.deepEqual(verify(swap(fields)), { ok: false, reason: "bad-signature" });
  }
  const first = BASE64URL[(BASE64URL.indexOf(signature[0]!) + 1) % 64]!;
  assert.deepEqual(verify(`${version}.${kid}.${payload}.${first}${signature.slice(1)}`), { ok: false, reason: "bad-signature" });
  // The last character's low two bits are padding: a different string that decodes to the same bytes is still refused.
  const spare = BASE64URL[BASE64URL.indexOf(signature.at(-1)!) + 1]!;
  assert.deepEqual(verify(`${version}.${kid}.${payload}.${signature.slice(0, -1)}${spare}`), { ok: false, reason: "bad-signature" });
  const both = createUnsubscribeKeyring({ current: "k1", keys: { k1: OLD, k2: NEW } });
  assert.deepEqual(verify(`${version}.k2.${payload}.${signature}`, both), { ok: false, reason: "bad-signature" });
  assert.deepEqual(verify(`${version}.constructor.${payload}.${signature}`), { ok: false, reason: "unknown-key" });
  for (const junk of [null, undefined, 42, {}, "", "v1.k1", "forged", `${token}.x`, `v2.${kid}.${payload}.${signature}`, `${version}.K1.${payload}.${signature}`,
    `${version}.${kid}.${payload}.${signature}=`, `${version}.${kid}.${payload}+.${signature}`, `${token}${"A".repeat(1100)}`]) {
    assert.deepEqual(verify(junk), { ok: false, reason: "malformed" }, String(junk));
  }
});

test("a correctly signed token is still refused for the wrong purpose, a bad shape or outside its window", () => {
  assert.deepEqual(verify(tokenOf(linkFor(pat, CATEGORY, ring, "other-purpose"))), { ok: false, reason: "wrong-purpose" });
  assert.deepEqual(verify(signedToken(["other-purpose", "tenant-a", pat.subject, CATEGORY, DAY])), { ok: false, reason: "wrong-purpose" });
  for (const fields of [
    [PURPOSE, "tenant a", pat.subject, CATEGORY, DAY],
    [PURPOSE, "tenant-a", "pat@example.test", CATEGORY, DAY],
    [PURPOSE, "tenant-a", pat.subject, "Weekly Report", DAY],
    [PURPOSE, "tenant-a", pat.subject, CATEGORY, 1.5],
    [PURPOSE, "tenant-a", pat.subject, CATEGORY],
    [7, "tenant-a", pat.subject, CATEGORY, DAY],
    { p: PURPOSE, t: "tenant-a", s: pat.subject, c: CATEGORY, d: DAY },
  ]) {
    assert.deepEqual(verify(signedToken(fields)), { ok: false, reason: "malformed" }, JSON.stringify(fields));
  }
  const at = (day: number) => verify(signedToken([PURPOSE, "tenant-a", pat.subject, CATEGORY, day]));
  assert.equal(at(DAY - 180).ok, true);
  assert.deepEqual(at(DAY - 181), { ok: false, reason: "expired" });
  assert.equal(at(DAY + 1).ok, true);
  assert.deepEqual(at(DAY + 2), { ok: false, reason: "expired" });
  assert.equal(verify(signedToken([PURPOSE, "tenant-a", pat.subject, CATEGORY, DAY - 300]), ring, { maxAgeDays: 365 }).ok, true);
  assert.throws(() => verify(tokenOf(linkFor()), ring, { maxAgeDays: 30 }), RangeError);
});

test("keyrings, links and subjects are checked when they are built", () => {
  assert.ok(Object.isFrozen(ring) && Object.isFrozen(ring.keys));
  assert.throws(() => createUnsubscribeKeyring({ current: "k1", keys: { k1: "short" } }), /at least 32/);
  assert.throws(() => createUnsubscribeKeyring({ current: "K1", keys: { K1: OLD } }), /key id/);
  assert.throws(() => createUnsubscribeKeyring({ current: "k2", keys: { k1: OLD } }), /current/);
  assert.throws(() => createUnsubscribeKeyring({ current: "", keys: { k1: OLD } }), /current/);
  assert.throws(() => createUnsubscribeKeyring({ current: "k1", keys: {} }), /at least one key/);
  for (const baseUrl of ["http://learn.example.test/api/unsubscribe", `${BASE}?x=1`, `${BASE}#top`, "https://user:pw@learn.example.test/u", "https://learn.example.test/a,b", "/api/unsubscribe"]) {
    assert.throws(() => unsubscribeLink({ baseUrl, keyring: ring, purpose: PURPOSE, who: pat, category: CATEGORY }), /baseUrl/, baseUrl);
  }
  assert.throws(() => linkFor(pat, "Weekly Report"), /category/);
  assert.throws(() => linkFor({ tenant: "tenant-a", subject: "pat@example.test" }), /subject/);
  assert.throws(() => linkFor(pat, CATEGORY, ring, "Bad Purpose"), /purpose/);
});

test("subjectForAddress: 'e:' + 32 hex of HMAC-SHA256(pepper, tenant LF address), case-blind, bound to the tenant", () => {
  const expected = `e:${createHmac("sha256", PEPPER).update("tenant-a\npat@example.test").digest("hex").slice(0, 32)}`;
  assert.equal(pat.subject, expected);
  assert.equal(subjectForAddress("tenant-a", "  Pat@Example.TEST \n", PEPPER), expected);
  assert.notEqual(subjectForAddress("tenant-b", "pat@example.test", PEPPER), expected);
  assert.notEqual(subjectForAddress("tenant-a", "pat@example.test", "q".repeat(40)), expected);
  assert.throws(() => subjectForAddress("tenant-a", "pat@example.test", "short"), /pepper/);
  assert.throws(() => subjectForAddress("tenant-a", "not-an-address", PEPPER), /address/);
  assert.throws(() => subjectForAddress("tenant a", "pat@example.test", PEPPER), /tenant/);
});

test("memory store: off keeps the first time and the latest source, on clears it, keys compare exactly", async () => {
  let clock = new Date("2026-01-01T00:00:00Z");
  const store = createMemoryOptOutStore({ now: () => clock });
  assert.equal(await store.isOff(pat, CATEGORY), false);
  await store.setOff(pat, CATEGORY, "link");
  clock = new Date("2026-02-01T00:00:00Z");
  await store.setOff(pat, CATEGORY, "one-click");
  assert.equal(await store.isOff(pat, CATEGORY), true);
  assert.deepEqual(await store.list(pat), [{ category: CATEGORY, offAt: new Date("2026-01-01T00:00:00Z"), source: "one-click" }]);
  await store.setOff(pat, "a-digest", "account");
  assert.deepEqual((await store.list(pat)).map(entry => entry.category), ["a-digest", CATEGORY]);

  assert.equal(await store.isOff(sam, CATEGORY), false);
  assert.equal(await store.isOff({ tenant: "tenant-b", subject: pat.subject }, CATEGORY), false);
  assert.equal(await store.isOff({ tenant: "Tenant-A", subject: pat.subject }, CATEGORY), false);
  assert.deepEqual(await store.list({ tenant: "tenant-b", subject: pat.subject }), []);

  await store.setOn(pat, CATEGORY, "account");
  assert.equal(await store.isOff(pat, CATEGORY), false);
  assert.deepEqual((await store.list(pat)).map(entry => entry.category), ["a-digest"]);
  clock = new Date("2026-03-01T00:00:00Z");
  await store.setOff(pat, CATEGORY, "admin");
  assert.deepEqual((await store.list(pat)).find(entry => entry.category === CATEGORY)?.offAt, clock);

  await assert.rejects(store.setOff(pat, CATEGORY, "email" as never), /source/);
  await assert.rejects(store.isOff({ tenant: "tenant-a", subject: "pat@example.test" }, CATEGORY), /subject/);
  await assert.rejects(store.isOff(pat, "Weekly Report"), /category/);
});

function fakeDb(rows: Record<string, unknown>[] = []) {
  const calls: { kind: "query" | "execute"; sql: string; params: OptOutSqlParam[] }[] = [];
  const TYPES = { NVarChar: { type: "NVarChar" }, VarChar: { type: "VarChar" } };
  const db: OptOutDb = {
    TYPES,
    async query<T>(sql: string, params: OptOutSqlParam[] = []) {
      calls.push({ kind: "query", sql, params });
      return { rows: rows as T[], rowCount: rows.length };
    },
    async execute(sql: string, params: OptOutSqlParam[] = []) {
      calls.push({ kind: "execute", sql, params });
      return 1;
    },
  };
  return { db, calls, TYPES };
}

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

test("SQL store: parameterised upserts into <schema>.EmailOptOuts with OffAt NULL meaning on", async () => {
  const { db, calls, TYPES } = fakeDb();
  for (const schema of ["dbo", "DBO", "lms;drop", "", "1lms"]) assert.throws(() => createSqlOptOutStore({ schema, db }), /schema/, schema);
  assert.throws(() => createSqlOptOutStore({ schema: "lms", db: {} as OptOutDb }), /query, execute and TYPES/);
  const store = createSqlOptOutStore({ schema: "lms", db });
  const who = [
    { name: "tenant", type: TYPES.NVarChar, value: "tenant-a" },
    { name: "subject", type: TYPES.VarChar, value: pat.subject },
  ];

  await store.setOff(pat, CATEGORY, "one-click");
  const off = calls.at(-1)!;
  assert.equal(off.kind, "execute");
  assert.deepEqual(off.params, [...who, { name: "category", type: TYPES.VarChar, value: CATEGORY }, { name: "source", type: TYPES.VarChar, value: "one-click" }]);
  const offSql = squash(off.sql);
  assert.match(offSql, /^MERGE \[lms\]\.\[EmailOptOuts\] WITH \(HOLDLOCK\) AS target USING \(VALUES \(@tenant, @subject, @category\)\)/);
  assert.match(offSql, /ON target\.TenantKey = src\.TenantKey AND target\.Subject = src\.Subject AND target\.Category = src\.Category/);
  assert.match(offSql, /WHEN MATCHED THEN UPDATE SET OffAt = COALESCE\(target\.OffAt, SYSUTCDATETIME\(\)\), Source = @source, UpdatedAt = SYSUTCDATETIME\(\)/);
  assert.match(offSql, /VALUES \(src\.TenantKey, src\.Subject, src\.Category, SYSUTCDATETIME\(\), @source, SYSUTCDATETIME\(\)\);$/);

  await store.setOn(pat, CATEGORY, "account");
  const on = calls.at(-1)!;
  assert.equal(on.kind, "execute");
  assert.equal(on.params.at(-1)?.value, "account");
  assert.match(squash(on.sql), /UPDATE SET OffAt = NULL, Source = @source/);
  assert.match(squash(on.sql), /VALUES \(src\.TenantKey, src\.Subject, src\.Category, NULL, @source, SYSUTCDATETIME\(\)\);$/);

  for (const call of calls) {
    assert.ok(!call.sql.includes(pat.subject) && !call.sql.includes("tenant-a") && !call.sql.includes(CATEGORY), "values travel only as parameters");
  }

  assert.equal(await store.isOff(pat, CATEGORY), false);
  const isOff = calls.at(-1)!;
  assert.equal(isOff.kind, "query");
  assert.equal(isOff.params.length, 3);
  assert.match(squash(isOff.sql), /FROM \[lms\]\.\[EmailOptOuts\] WHERE TenantKey = @tenant AND Subject = @subject AND Category = @category AND OffAt IS NOT NULL/);
  assert.equal(await createSqlOptOutStore({ schema: "lms", db: fakeDb([{ IsOff: 1 }]).db }).isOff(pat, CATEGORY), true);

  const before = calls.length;
  await assert.rejects(store.setOff({ tenant: "tenant-a", subject: "pat@example.test" }, CATEGORY, "link"), /subject/);
  await assert.rejects(store.setOn(pat, CATEGORY, "email" as never), /source/);
  assert.equal(calls.length, before, "nothing reaches SQL with a bad subject or source");
});

test("SQL store: list reads switched-off rows for one subject, ordered by category", async () => {
  const rows = [
    { Category: "a-digest", OffAt: new Date("2026-01-02T00:00:00Z"), Source: "account" },
    { Category: CATEGORY, OffAt: "2026-01-03T00:00:00.000Z", Source: "link" },
  ];
  const { db, calls, TYPES } = fakeDb(rows);
  assert.deepEqual(await createSqlOptOutStore({ schema: "lms", db }).list(pat), [
    { category: "a-digest", offAt: new Date("2026-01-02T00:00:00Z"), source: "account" },
    { category: CATEGORY, offAt: new Date("2026-01-03T00:00:00Z"), source: "link" },
  ]);
  assert.deepEqual(calls[0]?.params, [
    { name: "tenant", type: TYPES.NVarChar, value: "tenant-a" },
    { name: "subject", type: TYPES.VarChar, value: pat.subject },
  ]);
  assert.match(squash(calls[0]!.sql), /^SELECT TOP \(256\) Category, OffAt, Source FROM \[lms\]\.\[EmailOptOuts\] WHERE TenantKey = @tenant AND Subject = @subject AND OffAt IS NOT NULL ORDER BY Category;$/);
});

test("SQL store: every column it writes and every source it can send exist in the LMS migration", async () => {
  const migration = readFileSync(new URL("../../db/migrations/0022_email_optouts.sql", import.meta.url), "utf8");
  const table = migration.slice(migration.indexOf("CREATE TABLE"), migration.indexOf("CONSTRAINT PK_EmailOptOuts"));
  const columns = [...table.matchAll(/^\s+(\w+)\s+(?:N?VARCHAR|DATETIME2)/gm)].map(match => match[1]);
  const { db, calls } = fakeDb();
  await createSqlOptOutStore({ schema: "lms", db }).setOff(pat, CATEGORY, "link");
  const inserted = /INSERT \(([^)]+)\)/.exec(calls[0]!.sql)?.[1]?.split(",").map(name => name.trim());
  assert.deepEqual(inserted, columns);
  assert.match(table, /TenantKey\s+NVARCHAR\(64\)\s+COLLATE Latin1_General_100_BIN2/);
  const check = /CHECK \(Source IN \(([^)]+)\)\)/.exec(migration)?.[1];
  assert.deepEqual(check?.split(",").map(value => value.trim().replace(/'/g, "")), ["link", "one-click", "account", "admin"]);
});

function route(overrides: Partial<UnsubscribeRouteOptions> = {}) {
  const store = overrides.store ?? createMemoryOptOutStore();
  const errors: { error: unknown; context: UnsubscribeErrorContext }[] = [];
  const handlers = createUnsubscribeRouteHandler({
    keyring: ring,
    purpose: PURPOSE,
    page: { productName: "Example Learning" },
    now: () => new Date(NOW),
    onError: (error, context) => {
      errors.push({ error, context });
    },
    ...overrides,
    store,
  });
  return { GET: handlers.GET, POST: handlers.POST, store, errors };
}

const post = (url: string, body = "", type = "application/x-www-form-urlencoded") =>
  new Request(url, { method: "POST", headers: { "Content-Type": type }, body });
const ONE_CLICK = "List-Unsubscribe=One-Click";

test("route GET only asks: an escaped confirmation page whose one button posts the same token back", async () => {
  const pages: string[] = [];
  const app = route({
    page: async tenant => {
      pages.push(tenant);
      return {
        productName: `<b>${tenant}</b> & "Co"`,
        primaryColor: "#ffffff",
        accountUrl: "https://learn.example.test/settings?a=1&b=2",
        categoryLabels: { [CATEGORY]: "weekly <report> emails" },
      };
    },
  });
  const url = linkFor();
  const response = await app.GET(new Request(url));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html; charset=utf-8$/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'.*form-action 'self'/);
  const html = await response.text();
  assert.ok(html.includes(`<form method="post" action="?t=${tokenOf(url)}"><button type="submit">Unsubscribe</button></form>`));
  assert.ok(html.includes("You will stop getting weekly &lt;report&gt; emails from &lt;b&gt;tenant-a&lt;/b&gt; &amp; &quot;Co&quot;."));
  assert.ok(html.includes('<a href="https://learn.example.test/settings?a=1&amp;b=2">'));
  assert.doesNotMatch(html, /<b>|<script|https?:\/\/(?!learn\.example\.test)/);
  assert.match(html, /color: #111111; background: #ffffff/);
  assert.deepEqual(pages, ["tenant-a"]);
  assert.equal(await app.store.isOff(pat, CATEGORY), false, "GET changes nothing");

  const plain = await route().GET(new Request(url));
  assert.match(await plain.text(), /You will stop getting these emails from Example Learning\./);
});

test("route POST from the page's button switches the category off as 'link' and answers a page", async () => {
  const app = route();
  const response = await app.POST(post(linkFor()));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>You are unsubscribed<\/h1>/);
  assert.deepEqual((await app.store.list(pat)).map(entry => [entry.category, entry.source]), [[CATEGORY, "link"]]);
  assert.equal(await app.store.isOff(sam, CATEGORY), false);
  assert.equal(await app.store.isOff(pat, "a-digest"), false);
});

test("route RFC 8058 one-click, urlencoded or multipart, switches off as 'one-click' with a bare 200 and no page lookup", async () => {
  const app = route({ page: () => { throw new Error("one-click needs no page"); } });
  const response = await app.POST(post(linkFor(), ONE_CLICK));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(await response.text(), "Unsubscribed\n");
  assert.deepEqual((await app.store.list(pat)).map(entry => entry.source), ["one-click"]);

  const form = new FormData();
  form.set("List-Unsubscribe", "One-Click");
  const multipart = await app.POST(new Request(linkFor(sam), { method: "POST", body: form }));
  assert.equal(multipart.status, 200);
  assert.equal(await app.store.isOff(sam, CATEGORY), true);

  const otherTenant = { tenant: "tenant-b", subject: subjectForAddress("tenant-b", "pat@example.test", PEPPER) };
  await app.POST(post(linkFor(otherTenant), ONE_CLICK));
  assert.equal(await app.store.isOff(otherTenant, CATEGORY), true);
  assert.deepEqual(app.errors, []);
});

test("route: bad, forged, tampered, wrong-purpose, unknown-key and expired links get 400, a neutral page and no write", async () => {
  const app = route({ page: () => { throw new Error("never asked for an unverified tenant"); } });
  const [version, kid, payload, signature] = partsOf(tokenOf(linkFor()));
  const tampered = `${version}.${kid}.${Buffer.from(JSON.stringify([PURPOSE, "tenant-a", pat.subject, "a-digest", DAY])).toString("base64url")}.${signature}`;
  const urls = [
    BASE,
    `${BASE}?t=forged`,
    `${BASE}?t=${tampered}`,
    linkFor(pat, CATEGORY, ring, "other-purpose"),
    linkFor(pat, CATEGORY, createUnsubscribeKeyring({ current: "k9", keys: { k9: NEW } })),
    linkFor(pat, CATEGORY, ring, PURPOSE, NOW - 181 * DAY_MS),
  ];
  for (const url of urls) {
    const asked = await app.GET(new Request(url));
    assert.equal(asked.status, 400, url);
    const html = await asked.text();
    assert.match(html, /not valid or has expired/);
    assert.doesNotMatch(html, /Example Learning|tenant-a|<form/);
    assert.equal((await app.POST(post(url))).status, 400, url);
    const oneClick = await app.POST(post(url, ONE_CLICK));
    assert.equal(oneClick.status, 400, url);
    assert.match(oneClick.headers.get("content-type") ?? "", /^text\/plain/);
  }
  assert.deepEqual(await app.store.list(pat), []);
  assert.deepEqual(await app.store.list({ tenant: "tenant-a", subject: pat.subject }), []);
  assert.deepEqual(app.errors, []);
});

test("route: a store or page failure answers 503, is reported, and changes nothing", async () => {
  const failing: OptOutStore = { ...createMemoryOptOutStore(), setOff: async () => { throw new Error("database unavailable"); } };
  const app = route({ store: failing });
  const oneClick = await app.POST(post(linkFor(), ONE_CLICK));
  assert.equal(oneClick.status, 503);
  assert.match(oneClick.headers.get("content-type") ?? "", /^text\/plain/);
  const button = await app.POST(post(linkFor()));
  assert.equal(button.status, 503);
  assert.match(await button.text(), /nothing changed/);
  assert.deepEqual(app.errors.map(entry => entry.context), [
    { stage: "store", category: CATEGORY, source: "one-click" },
    { stage: "store", category: CATEGORY, source: "link" },
  ]);
  assert.equal((await route({ store: failing, onError: () => { throw new Error("logger down"); } }).POST(post(linkFor(), ONE_CLICK))).status, 503);

  const broken = route({ page: async () => { throw new Error("tenant lookup failed"); } });
  assert.equal((await broken.GET(new Request(linkFor()))).status, 503);
  assert.equal((await broken.POST(post(linkFor()))).status, 503);
  assert.equal(await broken.store.isOff(pat, CATEGORY), false, "a page that cannot render writes nothing");
  assert.deepEqual(broken.errors.map(entry => entry.context), [
    { stage: "page", category: CATEGORY },
    { stage: "page", category: CATEGORY, source: "link" },
  ]);
  const badPage = route({ page: () => ({ productName: "Example Learning", primaryColor: "red" }) });
  assert.equal((await badPage.GET(new Request(linkFor()))).status, 503);
  assert.match(String(badPage.errors[0]?.error), /primaryColor/);
});

test("route: an oversized body is refused with 413 before anything is written", async () => {
  const app = route();
  assert.equal((await app.POST(post(linkFor(), `${ONE_CLICK}&pad=${"x".repeat(9000)}`))).status, 413);
  assert.equal(await app.store.isOff(pat, CATEGORY), false);
});

test("no key: no link is minted and no route can be built; bad route options fail at construction", () => {
  assert.equal(unsubscribeLink({ baseUrl: BASE, keyring: null, purpose: PURPOSE, who: pat, category: CATEGORY }), null);
  assert.equal(unsubscribeLink({ baseUrl: BASE, purpose: PURPOSE, who: pat, category: CATEGORY }), null);
  const store = createMemoryOptOutStore();
  const page = { productName: "Example Learning" };
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: null as never, purpose: PURPOSE, store, page }), /keyring is required/);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: { current: "k1", keys: {} }, purpose: PURPOSE, store, page }), /at least one key/);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: ring, purpose: "Bad Purpose", store, page }), /purpose/);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: ring, purpose: PURPOSE, store, page: { productName: " " } }), /productName/);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: ring, purpose: PURPOSE, store, page: { productName: "X", accountUrl: "http://learn.example.test" } }), /accountUrl/);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: ring, purpose: PURPOSE, store, page, maxAgeDays: 30 }), RangeError);
  assert.throws(() => createUnsubscribeRouteHandler({ keyring: ring, purpose: PURPOSE, store: null as never, page }), /store is required/);
});
