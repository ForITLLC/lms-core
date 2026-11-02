// Opt-out store and signed unsubscribe links for the public tree.
import { createHmac, timingSafeEqual } from "node:crypto";

export interface UnsubscribeTarget {
  url: string;
  mailto?: string;
}
export type MailKind = "reply" | "intake" | "notification";
export type MailCategory = string;
export type OptOutSource = "link" | "one-click" | "account" | "admin";
export interface OptOutSubject {
  tenant: string;
  subject: string;
}
export interface OptOutEntry {
  category: MailCategory;
  offAt: Date;
  source: OptOutSource;
}
export interface OptOutStore {
  isOff(who: OptOutSubject, category: MailCategory): Promise<boolean>;
  setOff(who: OptOutSubject, category: MailCategory, source: OptOutSource): Promise<void>;
  setOn(who: OptOutSubject, category: MailCategory, source: OptOutSource): Promise<void>;
  list(who: OptOutSubject): Promise<OptOutEntry[]>;
}

const KID = /^[a-z0-9]{1,16}$/;
const PURPOSE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const CATEGORY = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const SUBJECT = /^(?:u:[A-Za-z0-9_.-]{1,64}|e:[0-9a-f]{32})$/;
const SCHEMA = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const SOURCES: readonly string[] = ["link", "one-click", "account", "admin"];
const MIN_SECRET_LENGTH = 32;
const DAY_MS = 86_400_000;
const DEFAULT_MAX_AGE_DAYS = 180;
// CASL: an unsubscribe mechanism must keep working for at least 60 days after the send.
const MIN_MAX_AGE_DAYS = 60;
const TOKEN_VERSION = "v1";
const MAX_TOKEN_LENGTH = 1024;
const MAX_LIST_ROWS = 256;

function isSubject(value: unknown): value is OptOutSubject {
  if (typeof value !== "object" || value === null) return false;
  const { tenant, subject } = value as Record<string, unknown>;
  return typeof tenant === "string" && TENANT.test(tenant) && typeof subject === "string" && SUBJECT.test(subject);
}

function isCategory(value: unknown): value is MailCategory {
  return typeof value === "string" && CATEGORY.test(value);
}

function checkWho(who: unknown): void {
  if (!isSubject(who)) throw new TypeError("opt-out subject must be { tenant, subject } with subject 'u:<id>' or 'e:<hash>'");
}

function checkArgs(who: unknown, category: unknown, source?: unknown): void {
  checkWho(who);
  if (!isCategory(category)) throw new TypeError(`opt-out category must match ${CATEGORY}`);
  if (source !== undefined && (typeof source !== "string" || !SOURCES.includes(source))) {
    throw new TypeError(`opt-out source must be one of ${SOURCES.join(", ")}`);
  }
}

function checkPurpose(purpose: unknown): void {
  if (typeof purpose !== "string" || !PURPOSE.test(purpose)) throw new TypeError(`unsubscribe purpose must match ${PURPOSE}`);
}

/**
 * `e:` + the first 32 hex of HMAC-SHA256(pepper, tenant + "\n" + address), the address trimmed,
 * lower-cased and NFC-normalised. The address itself is never stored or put in a link. The pepper
 * must stay fixed: a new one gives every address a new subject and orphans its stored opt-outs.
 */
export function subjectForAddress(tenant: string, address: string, pepper: string): string {
  if (typeof tenant !== "string" || !TENANT.test(tenant)) throw new TypeError(`tenant must match ${TENANT}`);
  if (typeof pepper !== "string" || Buffer.byteLength(pepper, "utf8") < MIN_SECRET_LENGTH) {
    throw new TypeError(`address pepper must be a secret of at least ${MIN_SECRET_LENGTH} bytes`);
  }
  const normalized = typeof address === "string" ? address.trim().toLowerCase().normalize("NFC") : "";
  if (!normalized.includes("@") || /[\r\n]/.test(normalized)) throw new TypeError("address must be an email address");
  return `e:${createHmac("sha256", pepper).update(`${tenant}\n${normalized}`).digest("hex").slice(0, 32)}`;
}

export interface UnsubscribeKeyring {
  current: string;
  keys: Record<string, string>;
}

function secretFor(keyring: UnsubscribeKeyring, kid: string): string | undefined {
  return Object.hasOwn(keyring.keys, kid) ? keyring.keys[kid] : undefined;
}

function checkKeyring(keyring: unknown): asserts keyring is UnsubscribeKeyring {
  if (typeof keyring !== "object" || keyring === null) throw new TypeError("unsubscribe keyring is required");
  const { current, keys } = keyring as Record<string, unknown>;
  if (typeof keys !== "object" || keys === null || Object.keys(keys).length === 0) {
    throw new TypeError("unsubscribe keyring needs at least one key");
  }
  for (const [kid, secret] of Object.entries(keys)) {
    if (!KID.test(kid)) throw new TypeError(`unsubscribe key id "${kid}" must match ${KID}`);
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new TypeError(`unsubscribe key "${kid}" must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (typeof current !== "string" || !Object.hasOwn(keys, current)) {
    throw new TypeError('unsubscribe keyring "current" must name one of its keys');
  }
}

/** Validates the keyring and returns a frozen copy, so a bad key fails at startup rather than at a send. */
export function createUnsubscribeKeyring(input: UnsubscribeKeyring): UnsubscribeKeyring {
  checkKeyring(input);
  return Object.freeze({ current: input.current, keys: Object.freeze({ ...input.keys }) });
}

function resolveMaxAgeDays(maxAgeDays: number | undefined): number {
  if (maxAgeDays === undefined) return DEFAULT_MAX_AGE_DAYS;
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < MIN_MAX_AGE_DAYS) {
    throw new RangeError(`maxAgeDays must be a whole number of at least ${MIN_MAX_AGE_DAYS}`);
  }
  return maxAgeDays;
}

function dayOf(now: Date | number | undefined): number {
  const ms = now === undefined ? Date.now() : typeof now === "number" ? now : now.getTime();
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError("now must be a valid time");
  return Math.floor(ms / DAY_MS);
}

function sign(secret: string, signed: string): string {
  return createHmac("sha256", secret).update(signed).digest("base64url");
}

// v1.<kid>.<base64url(JSON [purpose, tenant, subject, category, day])>.<base64url(HMAC-SHA256(key, "v1.<kid>.<payload>"))>
// `day` is whole UTC days since the epoch at mint; `kid` picks the verifying key so keys can rotate.
function mintToken(keyring: UnsubscribeKeyring, purpose: string, who: OptOutSubject, category: MailCategory, now?: Date | number): string {
  const secret = secretFor(keyring, keyring.current);
  if (secret === undefined) throw new TypeError('unsubscribe keyring "current" must name one of its keys');
  const payload = Buffer.from(JSON.stringify([purpose, who.tenant, who.subject, category, dayOf(now)]), "utf8").toString("base64url");
  const signed = `${TOKEN_VERSION}.${keyring.current}.${payload}`;
  return `${signed}.${sign(secret, signed)}`;
}

export type UnsubscribeTokenFailure = "malformed" | "unknown-key" | "bad-signature" | "expired" | "wrong-purpose";
export type UnsubscribeTokenResult =
  | { ok: true; who: OptOutSubject; category: MailCategory; mintedDay: number }
  | { ok: false; reason: UnsubscribeTokenFailure };

export interface VerifyUnsubscribeTokenOptions {
  keyring: UnsubscribeKeyring;
  purpose: string;
  /** Default 180; below 60 throws. */
  maxAgeDays?: number;
  now?: Date | number;
}

/** Throws only on the caller's own options; anything wrong with the token comes back as `{ ok: false, reason }`. */
export function verifyUnsubscribeToken(token: unknown, options: VerifyUnsubscribeTokenOptions): UnsubscribeTokenResult {
  checkKeyring(options.keyring);
  checkPurpose(options.purpose);
  const maxAgeDays = resolveMaxAgeDays(options.maxAgeDays);
  const today = dayOf(options.now);
  const fail = (reason: UnsubscribeTokenFailure): UnsubscribeTokenResult => ({ ok: false, reason });

  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return fail("malformed");
  const parts = token.split(".");
  if (parts.length !== 4) return fail("malformed");
  const [version, kid, payload, signature] = parts as [string, string, string, string];
  if (version !== TOKEN_VERSION || !KID.test(kid) || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) {
    return fail("malformed");
  }
  const secret = secretFor(options.keyring, kid);
  if (secret === undefined) return fail("unknown-key");
  const expected = Buffer.from(sign(secret, `${version}.${kid}.${payload}`), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return fail("bad-signature");

  let fields: unknown;
  try {
    fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return fail("malformed");
  }
  if (!Array.isArray(fields) || fields.length !== 5) return fail("malformed");
  const [purpose, tenant, subject, category, day] = fields as unknown[];
  if (typeof purpose !== "string") return fail("malformed");
  if (purpose !== options.purpose) return fail("wrong-purpose");
  const who = { tenant, subject };
  if (!isSubject(who) || !isCategory(category) || typeof day !== "number" || !Number.isSafeInteger(day) || day < 0) {
    return fail("malformed");
  }
  if (day > today + 1 || today - day > maxAgeDays) return fail("expired");
  return { ok: true, who: { tenant: who.tenant, subject: who.subject }, category, mintedDay: day };
}

export interface UnsubscribeLinkInput {
  /** The public https URL of the unsubscribe route, with no query or fragment. */
  baseUrl: string;
  keyring?: UnsubscribeKeyring | null;
  purpose: string;
  who: OptOutSubject;
  category: MailCategory;
  now?: Date | number;
}

function checkBaseUrl(baseUrl: unknown): void {
  // The URL also goes in a List-Unsubscribe header as <url>, so no space, quote, bracket or comma.
  const message = "unsubscribe baseUrl must be an absolute https URL with no credentials, query or fragment";
  if (typeof baseUrl !== "string" || !/^https:\/\/[\x21-\x7e]+$/i.test(baseUrl) || /[<>,"'?#\\]/.test(baseUrl)) throw new TypeError(message);
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError(message);
  }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) throw new TypeError(message);
}

/** The signed link for one subject and one category, or null when there is no keyring (send no notification then). */
export function unsubscribeLink(input: UnsubscribeLinkInput): UnsubscribeTarget | null {
  checkBaseUrl(input.baseUrl);
  if (input.keyring === undefined || input.keyring === null) return null;
  checkKeyring(input.keyring);
  checkPurpose(input.purpose);
  checkArgs(input.who, input.category);
  return { url: `${input.baseUrl}?t=${mintToken(input.keyring, input.purpose, input.who, input.category, input.now)}` };
}

export interface MemoryOptOutStoreOptions {
  now?: () => Date;
}

interface MemoryRow {
  tenant: string;
  subject: string;
  category: MailCategory;
  offAt: Date | null;
  source: OptOutSource;
}

function byCategory(a: OptOutEntry, b: OptOutEntry): number {
  return a.category < b.category ? -1 : a.category > b.category ? 1 : 0;
}

export function createMemoryOptOutStore(options: MemoryOptOutStoreOptions = {}): OptOutStore {
  const now = options.now ?? (() => new Date());
  const rows = new Map<string, MemoryRow>();
  const keyOf = (who: OptOutSubject, category: MailCategory) => JSON.stringify([who.tenant, who.subject, category]);
  const put = (who: OptOutSubject, category: MailCategory, offAt: Date | null, source: OptOutSource) =>
    rows.set(keyOf(who, category), { tenant: who.tenant, subject: who.subject, category, offAt, source });
  return {
    async isOff(who, category) {
      checkArgs(who, category);
      return Boolean(rows.get(keyOf(who, category))?.offAt);
    },
    async setOff(who, category, source) {
      checkArgs(who, category, source);
      put(who, category, rows.get(keyOf(who, category))?.offAt ?? now(), source);
    },
    async setOn(who, category, source) {
      checkArgs(who, category, source);
      put(who, category, null, source);
    },
    async list(who) {
      checkWho(who);
      const entries: OptOutEntry[] = [];
      for (const row of rows.values()) {
        if (row.tenant === who.tenant && row.subject === who.subject && row.offAt) {
          entries.push({ category: row.category, offAt: new Date(row.offAt), source: row.source });
        }
      }
      return entries.sort(byCategory).slice(0, MAX_LIST_ROWS);
    },
  };
}

export interface OptOutSqlParam {
  name: string;
  type: unknown;
  value: unknown;
}

/** The two calls and the two parameter types the SQL store needs from a SQL Server client. */
export interface OptOutDb {
  query<T = Record<string, unknown>>(sql: string, params?: OptOutSqlParam[]): Promise<{ rows: T[]; rowCount: number }>;
  execute(sql: string, params?: OptOutSqlParam[]): Promise<number>;
  TYPES: { NVarChar: unknown; VarChar: unknown };
}

export interface SqlOptOutStoreOptions {
  /** The app's own schema holding EmailOptOuts; never dbo. */
  schema: string;
  db: OptOutDb;
}

/**
 * `<schema>.EmailOptOuts`: one row per (TenantKey, Subject, Category), OffAt NULL = on. setOff keeps
 * the first OffAt and records the latest Source, so a repeat click changes nothing that matters.
 */
export function createSqlOptOutStore(options: SqlOptOutStoreOptions): OptOutStore {
  const { schema, db } = options;
  if (typeof schema !== "string" || !SCHEMA.test(schema) || schema.toLowerCase() === "dbo") {
    throw new TypeError(`opt-out store schema must be the app's own schema (${SCHEMA}), never dbo`);
  }
  if (!db || typeof db.query !== "function" || typeof db.execute !== "function" || !db.TYPES) {
    throw new TypeError("opt-out store needs a db with query, execute and TYPES");
  }
  const table = `[${schema}].[EmailOptOuts]`;
  const isOffSql = `SELECT TOP (1) 1 AS IsOff FROM ${table}
WHERE TenantKey = @tenant AND Subject = @subject AND Category = @category AND OffAt IS NOT NULL;`;
  const listSql = `SELECT TOP (${MAX_LIST_ROWS}) Category, OffAt, Source FROM ${table}
WHERE TenantKey = @tenant AND Subject = @subject AND OffAt IS NOT NULL
ORDER BY Category;`;
  const upsertSql = (matchedOffAt: string, insertedOffAt: string) => `MERGE ${table} WITH (HOLDLOCK) AS target
USING (VALUES (@tenant, @subject, @category)) AS src (TenantKey, Subject, Category)
  ON target.TenantKey = src.TenantKey AND target.Subject = src.Subject AND target.Category = src.Category
WHEN MATCHED THEN
  UPDATE SET OffAt = ${matchedOffAt}, Source = @source, UpdatedAt = SYSUTCDATETIME()
WHEN NOT MATCHED THEN
  INSERT (TenantKey, Subject, Category, OffAt, Source, UpdatedAt)
  VALUES (src.TenantKey, src.Subject, src.Category, ${insertedOffAt}, @source, SYSUTCDATETIME());`;
  const setOffSql = upsertSql("COALESCE(target.OffAt, SYSUTCDATETIME())", "SYSUTCDATETIME()");
  const setOnSql = upsertSql("NULL", "NULL");

  // The key columns are NVARCHAR/VARCHAR with a binary collation; matching parameter types keep the seek on the key.
  const whoParams = (who: OptOutSubject): OptOutSqlParam[] => [
    { name: "tenant", type: db.TYPES.NVarChar, value: who.tenant },
    { name: "subject", type: db.TYPES.VarChar, value: who.subject },
  ];
  const rowParams = (who: OptOutSubject, category: MailCategory, source?: OptOutSource): OptOutSqlParam[] => [
    ...whoParams(who),
    { name: "category", type: db.TYPES.VarChar, value: category },
    ...(source === undefined ? [] : [{ name: "source", type: db.TYPES.VarChar, value: source }]),
  ];

  return {
    async isOff(who, category) {
      checkArgs(who, category);
      return (await db.query(isOffSql, rowParams(who, category))).rows.length > 0;
    },
    async setOff(who, category, source) {
      checkArgs(who, category, source);
      await db.execute(setOffSql, rowParams(who, category, source));
    },
    async setOn(who, category, source) {
      checkArgs(who, category, source);
      await db.execute(setOnSql, rowParams(who, category, source));
    },
    async list(who) {
      checkWho(who);
      const result = await db.query<{ Category: string; OffAt: Date | string; Source: OptOutSource }>(listSql, whoParams(who));
      return result.rows.map(row => ({
        category: row.Category,
        offAt: row.OffAt instanceof Date ? row.OffAt : new Date(row.OffAt),
        source: row.Source,
      }));
    },
  };
}

export interface UnsubscribePageOptions {
  /** Shown in the title and the sentence ("... from <productName>"). */
  productName: string;
  /** Button colour, `#rrggbb`; default a neutral grey. */
  primaryColor?: string;
  /** Absolute https URL of the page that holds the same switches. */
  accountUrl?: string;
  /** A noun phrase per category, e.g. `{ "weekly-report": "weekly report emails" }`; default "these emails". */
  categoryLabels?: Record<string, string>;
}
export type UnsubscribePageResolver = (tenant: string) => UnsubscribePageOptions | Promise<UnsubscribePageOptions>;
export interface UnsubscribeErrorContext {
  stage: "store" | "page";
  category: MailCategory;
  source?: OptOutSource;
}
export interface UnsubscribeRouteOptions {
  keyring: UnsubscribeKeyring;
  purpose: string;
  store: OptOutStore;
  /** One page for every link, or a function of the verified token's tenant (never called for an unverified link). */
  page: UnsubscribePageOptions | UnsubscribePageResolver;
  maxAgeDays?: number;
  /** Store and page-function failures; the answer is 503 either way. Default console.warn. */
  onError?: (error: unknown, context: UnsubscribeErrorContext) => void;
  now?: () => Date;
}
export interface UnsubscribeRouteHandlers {
  GET(request: Request): Promise<Response>;
  POST(request: Request): Promise<Response>;
}

const MAX_BODY_BYTES = 8 * 1024;
const NEUTRAL_COLOR = "#4b5563";
const RESPONSE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

interface Brand {
  name: string;
  color: string;
  accountUrl: string | null;
  labels: Record<string, string>;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function answer(body: string, status: number, type: "text/html" | "text/plain"): Response {
  return new Response(body, { status, headers: { "Content-Type": `${type}; charset=utf-8`, ...RESPONSE_HEADERS } });
}

function brandOf(page: unknown): Brand {
  if (typeof page !== "object" || page === null) throw new TypeError("unsubscribe page options are required");
  const { productName, primaryColor, accountUrl, categoryLabels } = page as Record<string, unknown>;
  if (typeof productName !== "string" || !productName.trim()) throw new TypeError("unsubscribe page.productName is required");
  if (primaryColor !== undefined && (typeof primaryColor !== "string" || !/^#[0-9a-fA-F]{6}$/.test(primaryColor))) {
    throw new TypeError("unsubscribe page.primaryColor must be #rrggbb");
  }
  if (accountUrl !== undefined) {
    let url: URL | null = null;
    try {
      url = typeof accountUrl === "string" && /^https:\/\//i.test(accountUrl) ? new URL(accountUrl) : null;
    } catch {
      url = null;
    }
    if (!url || url.username || url.password) throw new TypeError("unsubscribe page.accountUrl must be an absolute https URL");
  }
  const labels: Record<string, string> = {};
  if (categoryLabels !== undefined) {
    if (typeof categoryLabels !== "object" || categoryLabels === null) throw new TypeError("unsubscribe page.categoryLabels must be an object");
    for (const [key, label] of Object.entries(categoryLabels)) {
      if (typeof label !== "string") throw new TypeError(`unsubscribe page.categoryLabels["${key}"] must be a string`);
      if (label.trim()) labels[key] = label.trim();
    }
  }
  return {
    name: productName.trim(),
    color: typeof primaryColor === "string" ? primaryColor : NEUTRAL_COLOR,
    accountUrl: typeof accountUrl === "string" ? accountUrl : null,
    labels,
  };
}

function labelFor(brand: Brand, category: MailCategory): string {
  return Object.hasOwn(brand.labels, category) ? escapeHtml(brand.labels[category]!) : "these emails";
}

/** Near-black or white, whichever has more contrast on the button colour (WCAG relative luminance). */
function textOn(hex: string): string {
  const [r, g, b] = [1, 3, 5].map(i => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (luminance + 0.05) / 0.05 > 1.05 / (luminance + 0.05) ? "#111111" : "#ffffff";
}

function renderPage(brand: Brand | null, heading: string, body: string): string {
  const color = brand?.color ?? NEUTRAL_COLOR;
  const title = brand ? `${heading} - ${escapeHtml(brand.name)}` : heading;
  const account = brand?.accountUrl ? `<p class="account"><a href="${escapeHtml(brand.accountUrl)}">Choose which emails you get</a></p>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<style>
  body { margin: 0; padding: 48px 16px; font: 16px/1.5 system-ui, sans-serif; color: #1f2937; background: #f9fafb; }
  main { max-width: 460px; margin: 0 auto; padding: 24px 28px; background: #ffffff; border: 1px solid #e5e7eb; border-radius: 8px; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p { margin: 0 0 12px; }
  a { color: inherit; }
  button { font: inherit; font-weight: 600; padding: 10px 18px; border: 0; border-radius: 6px; cursor: pointer; color: ${textOn(color)}; background: ${color}; }
</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${body}
${account}
</main>
</body>
</html>`;
}

function tokenOf(request: Request): string | null {
  try {
    return new URL(request.url).searchParams.get("t");
  } catch {
    return null;
  }
}

/** At most MAX_BODY_BYTES, or null when the body is larger. */
async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** RFC 8058: the mail client posts `List-Unsubscribe=One-Click`, urlencoded or as multipart/form-data. */
async function isOneClick(body: Uint8Array<ArrayBuffer>, contentType: string): Promise<boolean> {
  try {
    if (/^multipart\/form-data/i.test(contentType)) {
      const form = await new Response(body, { headers: { "Content-Type": contentType } }).formData();
      return form.get("List-Unsubscribe") === "One-Click";
    }
    return new URLSearchParams(new TextDecoder().decode(body)).get("List-Unsubscribe") === "One-Click";
  } catch {
    return false;
  }
}

/**
 * GET only asks (a mail scanner prefetching the link must never unsubscribe anyone); POST switches the
 * category off, from the page's button or an RFC 8058 one-click, which gets bare text and no redirect.
 * The `t` query parameter is the only credential: no cookie or other header is read.
 */
export function createUnsubscribeRouteHandler(options: UnsubscribeRouteOptions): UnsubscribeRouteHandlers {
  const { keyring, purpose, store, page } = options;
  checkKeyring(keyring);
  checkPurpose(purpose);
  const maxAgeDays = resolveMaxAgeDays(options.maxAgeDays);
  if (!store || typeof store.setOff !== "function") throw new TypeError("unsubscribe store is required");
  const fixed = typeof page === "function" ? null : brandOf(page);
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((error: unknown) => console.warn("[unsubscribe]", error));
  const report = (error: unknown, context: UnsubscribeErrorContext) => {
    try {
      onError(error, context);
    } catch {
      // A failing logger must not turn the 503 into a 500.
    }
  };
  const brandFor = async (tenant: string, context: UnsubscribeErrorContext): Promise<Brand | null> => {
    if (fixed) return fixed;
    try {
      return brandOf(await (page as UnsubscribePageResolver)(tenant));
    } catch (error) {
      report(error, context);
      return null;
    }
  };
  const verify = (token: string | null) => verifyUnsubscribeToken(token, { keyring, purpose, maxAgeDays, now: now() });
  const invalid = () => answer(renderPage(null, "This link is not valid", "<p>This unsubscribe link is not valid or has expired.</p>"), 400, "text/html");
  const failed = (brand: Brand | null) =>
    answer(renderPage(brand, "Something went wrong", "<p>Your choice was not saved and nothing changed. Please open the link again later.</p>"), 503, "text/html");

  return {
    async GET(request) {
      const token = tokenOf(request);
      const result = verify(token);
      if (!result.ok) return invalid();
      const brand = await brandFor(result.who.tenant, { stage: "page", category: result.category });
      if (!brand) return failed(null);
      const action = escapeHtml(`?t=${encodeURIComponent(token ?? "")}`);
      return answer(renderPage(brand, "Unsubscribe?", `<p>You will stop getting ${labelFor(brand, result.category)} from ${escapeHtml(brand.name)}.</p>
<form method="post" action="${action}"><button type="submit">Unsubscribe</button></form>`), 200, "text/html");
    },
    async POST(request) {
      const body = await readBody(request);
      if (!body) return answer("Request body too large.\n", 413, "text/plain");
      const oneClick = await isOneClick(body, request.headers.get("content-type") ?? "");
      const result = verify(tokenOf(request));
      if (!result.ok) return oneClick ? answer("This link is not valid or has expired.\n", 400, "text/plain") : invalid();
      const source: OptOutSource = oneClick ? "one-click" : "link";
      // The button's answer is a page: resolve it before writing, so a page that cannot render changes nothing.
      const brand = oneClick ? null : await brandFor(result.who.tenant, { stage: "page", category: result.category, source });
      if (!oneClick && !brand) return failed(null);
      try {
        await store.setOff(result.who, result.category, source);
      } catch (error) {
        report(error, { stage: "store", category: result.category, source });
        return brand ? failed(brand) : answer("Could not unsubscribe right now. Please try again later.\n", 503, "text/plain");
      }
      if (!brand) return answer("Unsubscribed\n", 200, "text/plain");
      return answer(renderPage(brand, "You are unsubscribed", `<p>You will no longer get ${labelFor(brand, result.category)} from ${escapeHtml(brand.name)}.</p>`), 200, "text/html");
    },
  };
}
