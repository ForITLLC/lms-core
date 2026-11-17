// ============================================================================
// @foritllc/auth/microsoft - Microsoft sign-in through forit-Auth
//
// The app-side half of forit-Auth's app sign-in exchange for a Microsoft
// person, built to forit-Auth's Microsoft consumer contract
// (auth.microsoft-human-app-session-consumer-source-contract/v1, 2026-11-04).
// It is the same exchange the Google adapter uses (google.ts), with
// provider=microsoft, and it is laid out like that file on purpose. New files
// only: nothing here changes the Entra routes, the Google adapter, their
// cookies, the middleware or the helpers in `@foritllc/auth`.
//
// This is NOT the package's direct Entra sign-in (createForitAuth,
// createMultiTenantAuth, the MSAL routes). Those talk to Entra themselves and
// mint a BaseSession. Here the app holds no Microsoft client, secret or token:
// forit-Auth signs the person in and the app holds only Auth's opaque handle.
// A MicrosoftPrincipal is not a BaseSession and no Entra helper accepts one.
//
//   login     mints state, nonce, a PKCE S256 verifier and a random
//             transaction id in a signed `__Host-` transaction cookie
//             (10 minutes) and sends the browser to forit-Auth's authorize
//             route on the workspace host, with provider=microsoft.
//   callback  checks state against that cookie, consumes the transaction when
//             `consumeTransaction` is configured, redeems the code ONCE,
//             server to server, checks Auth's answer against configuration,
//             runs the policy, and sets `__Host-<appId>-ms-session`.
//   session   verifies the handle with forit-Auth on EVERY request and keeps
//             no positive answer past it. Fails closed: Auth unavailable is
//             503, never a stale or fallback identity. The answer must name
//             the session and person the cookie was bound to at sign-in, and
//             the policy runs again.
//   logout    same-origin POST with the session's CSRF value; revokes the
//             handle, clears the cookie.
//   csrf      same-origin GET only; answers this session's CSRF value and
//             nothing else, never stored by a cache.
//
// Admission is never implied. A person forit-Auth signed in is admitted only
// when the app's own `policy` says so, at the callback and on every request.
// The principal carries no guest, staff, group or email claim, because Auth
// sends none.
//
// Custody of the sign-in transaction, stated plainly. Without
// `consumeTransaction`, one-use rests on the signed, browser-bound,
// ten-minute transaction cookie, which the callback clears on every answer,
// plus forit-Auth's one-use code. Clearing a cookie is not proof across
// requests: a copy of the cookie taken earlier still opens, and what stops a
// second sign-in from it is Auth refusing the spent code. With
// `consumeTransaction`, the app's own store makes the transaction one-use
// across requests, and a replay never reaches Auth.
//
// The session cookie holds Auth's opaque handle and the binding taken at
// redeem (sessionId, principalId, tenantId, objectId, expiry), signed, never
// readable by page script. The session is never used past the bound expiry,
// even if Auth later reports a longer one.
//
// Edge-safe: web Request/Response and Web Crypto only, no next/* import.
// ============================================================================

import { OPAQUE_43 } from './google-exchange.js';
import {
  type MicrosoftPrincipal,
  type MicrosoftSignInConfig,
  type ResolvedMicrosoftConfig,
  CANONICAL_GUID,
  MicrosoftSignInNotConfiguredError,
  allowKey,
  assertMicrosoftSessionSecret,
  resolveMicrosoftConfig,
} from './microsoft-config.js';
import {
  type MicrosoftExchangeBinding,
  redeemMicrosoftCode,
  revokeMicrosoftHandle,
  verifyMicrosoftHandle,
} from './microsoft-exchange.js';
import { TX_MAX_AGE_SECONDS, constantTimeEqual, newTransaction } from './oauth-transaction.js';
import { safeReturnTo } from './return-to.js';
import { assertSessionSecret, signSessionPayload, verifySessionPayload } from './session-crypto.js';

export { MicrosoftSignInNotConfiguredError };
export type {
  MicrosoftPolicy,
  MicrosoftPolicyInput,
  MicrosoftPrincipal,
  MicrosoftSignInConfig,
} from './microsoft-config.js';

/** The `?error=` codes the adapter sends a browser to `errorPath` with. */
export const MICROSOFT_SIGNIN_ERRORS = Object.freeze({
  /** forit-Auth answered `access_denied`, or the app's policy refused. "Not allowed." */
  denied: 'microsoft_denied',
  /** forit-Auth answered `temporarily_unavailable`, or it could not be reached. Show Microsoft as unavailable. */
  unavailable: 'microsoft_unavailable',
  /** Anything else. A generic failure; the person may start a new sign-in. */
  failed: 'microsoft_failed',
  /** A route marked as needing MFA or a recent sign-in: Auth keeps no verified MFA claim. */
  mfaUnavailable: 'microsoft_mfa_unavailable',
} as const);

/** The header a state-changing request carries the session's CSRF value in. The same header the Google adapter reads. */
export const MICROSOFT_CSRF_HEADER = 'x-forit-csrf';

/**
 * Domain-separation tags under SESSION_SECRET. Entra uses `tx:` and plain
 * base64 JSON; Google uses `gtx:`, `gs:` and `gcsrf:`. No tag is a prefix of
 * another, so no value one adapter signs opens in another.
 */
const TX_TAG = 'mtx:';
const SESSION_TAG = 'ms:';
const CSRF_TAG = 'mcsrf:';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Only to build a path and query; never sent. */
const PATH_ONLY_BASE = 'https://same-origin.invalid';

/** A longer `returnTo` is dropped for `/`, not stored. */
const MAX_RETURN_TO = 2048;
/** Browsers drop a cookie over about 4096 bytes; the transaction cookie's whole Set-Cookie line stays inside it. */
const MAX_SET_COOKIE_BYTES = 4096;
/** Longest bound `sessionId` or `principalId` read back from the cookie (microsoft-exchange.ts accepts no longer). */
const MAX_ID_LENGTH = 128;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What one request's verify found. Only `signed_in` admits anyone. */
export type MicrosoftSessionState =
  | { status: 'signed_in'; principal: MicrosoftPrincipal; csrfToken: string }
  /** The adapter is dormant: no request was made. */
  | { status: 'unconfigured' }
  /** No usable Microsoft cookie, or its bound expiry has passed. `clearCookie` is set when a bad or expired one should go. */
  | { status: 'signed_out'; clearCookie?: string }
  /** forit-Auth answered 401 invalid_session: the session ended there. */
  | { status: 'ended'; clearCookie: string }
  /** forit-Auth answered 503, or did not answer. The cookie is kept. */
  | { status: 'unavailable' }
  /**
   * forit-Auth verified the session and the app's policy refused the person.
   * Nobody is admitted and no principal is given; the cookie is kept.
   * `csrfToken` is here only so a "not allowed" page can offer sign-out.
   */
  | { status: 'denied'; csrfToken: string }
  /**
   * Any other answer, an answer that names another session or person than the
   * cookie was bound to, or a policy that threw. Nobody is admitted; the cookie is kept.
   */
  | { status: 'failed' };

export interface RequireMicrosoftSessionOptions {
  /** Answer as an API (JSON 401/403/503) instead of redirecting. Default: the path starts with `/api/`. */
  api?: boolean;
  /**
   * The route needs MFA or a recent sign-in. forit-Auth keeps no verified
   * `auth_time`, `amr` or `acr`, so every Microsoft principal is refused.
   */
  requireMfa?: boolean;
}

export type RequireMicrosoftSessionResult =
  | { ok: true; principal: MicrosoftPrincipal; csrfToken: string }
  | { ok: false; response: Response };

/** What `sessionFromHeaders` reads the cookie from: a `Headers`, or what Next's `headers()` gives. */
export interface CookieHeaderSource {
  get(name: string): string | null;
}

export interface MicrosoftSignInHandlers {
  /** True when the adapter is live. Show the Microsoft button as unavailable otherwise. */
  readonly available: boolean;
  /** The session cookie's name, `__Host-<appId>-ms-session`, or null when dormant. */
  readonly cookieName: string | null;
  routes: {
    login(request: Request): Promise<Response>;
    callback(request: Request): Promise<Response>;
    logout(request: Request): Promise<Response>;
    /** GET `{ csrfToken }` for this request's verified, admitted session; 401 without one. */
    csrf(request: Request): Promise<Response>;
  };
  /**
   * Verify this request's Microsoft cookie with forit-Auth and run the policy,
   * once per Request object: the same object with the same cookie gets that
   * answer, and nothing is kept past the request. To ask again mid-request,
   * use sessionFromHeaders.
   */
  session(request: Request): Promise<MicrosoftSessionState>;
  /**
   * The same verify for code that has headers but no Request, such as a server
   * component: `await microsoft.sessionFromHeaders(await headers())`. Every
   * call asks Auth and runs the policy, and keeps nothing.
   */
  sessionFromHeaders(headers: CookieHeaderSource): Promise<MicrosoftSessionState>;
  /** `session()` plus the answer to send when it does not admit, the CSRF check and the MFA rule. */
  requireMicrosoftSession(
    request: Request,
    options?: RequireMicrosoftSessionOptions,
  ): Promise<RequireMicrosoftSessionResult>;
  /** The href for a Microsoft button, or null when dormant. */
  signInHref(returnTo?: string): string | null;
}

/** `loginPath?returnTo=` for a Microsoft button, same-origin paths only. */
export function microsoftSignInHref(loginPath = '/api/auth/microsoft/login', returnTo?: string): string {
  const path = safeReturnTo(loginPath, '/api/auth/microsoft/login');
  const back = returnTo === undefined ? '' : safeReturnTo(returnTo, '');
  return back ? `${path}?returnTo=${encodeURIComponent(back)}` : path;
}

// ---------------------------------------------------------------------------
// Encoding and cookies (edge-safe: no Buffer). These mirror google.ts, which
// keeps its own copies private.
// ---------------------------------------------------------------------------

// Mirrors google.ts encodeJson.
function encodeJson(value: unknown): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(value))) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Mirrors google.ts decodeJson.
function decodeJson(b64: string): unknown {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// Mirrors google.ts readCookie.
function readCookie(headers: CookieHeaderSource, name: string): string | undefined {
  const header = headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

// Mirrors google.ts setCookie.
function setCookie(name: string, value: string, maxAgeSec: number): string {
  // Host-only: `__Host-` forbids Domain and needs Secure and Path=/. Lax, not
  // Strict: the callback is a top-level navigation from the workspace host.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

interface MicrosoftTransaction {
  /** State. */
  s: string;
  /** Nonce. */
  n: string;
  /** PKCE code_verifier. */
  v: string;
  /** Expiry, ms since epoch. */
  exp: number;
  /** returnTo. */
  r: string;
  /** The transaction's own random id, handed to `consumeTransaction`. Never sent to Auth or the browser's URL. */
  t: string;
}

async function sealTransaction(tx: MicrosoftTransaction): Promise<string> {
  return signSessionPayload(TX_TAG + encodeJson(tx));
}

async function openTransaction(value: string | undefined, fallbackReturnTo: string): Promise<MicrosoftTransaction | null> {
  if (!value) return null;
  const payload = await verifySessionPayload(value);
  if (!payload || !payload.startsWith(TX_TAG)) return null;
  try {
    const tx = decodeJson(payload.slice(TX_TAG.length)) as Partial<MicrosoftTransaction> | null;
    if (
      !tx || typeof tx !== 'object' ||
      typeof tx.s !== 'string' || !tx.s ||
      typeof tx.n !== 'string' || !tx.n ||
      typeof tx.v !== 'string' || !tx.v ||
      typeof tx.t !== 'string' || !CANONICAL_GUID.test(tx.t) ||
      typeof tx.exp !== 'number' || tx.exp < Date.now()
    ) {
      return null;
    }
    return { s: tx.s, n: tx.n, v: tx.v, exp: tx.exp, r: safeReturnTo(tx.r, fallbackReturnTo), t: tx.t };
  } catch {
    return null;
  }
}

/** What the session cookie holds: Auth's handle and the binding taken at redeem. */
interface BoundSession {
  /** forit-Auth's opaque session handle. */
  h: string;
  /** identity.sessionId at redeem. */
  sid: string;
  /** identity.principalId at redeem. */
  pid: string;
  /** directory.tenantId at redeem. */
  t: string;
  /** directory.objectId at redeem. */
  o: string;
  /** The bound expiry, ms since epoch: never extended. */
  exp: number;
}

function boundId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH && !CONTROL.test(value);
}

async function sealSession(bound: BoundSession): Promise<string> {
  return signSessionPayload(SESSION_TAG + encodeJson(bound));
}

/** The binding in a cookie value, or null if unsigned, tampered, another adapter's or malformed. Expiry is the caller's check. */
async function openSession(value: string | undefined): Promise<BoundSession | null> {
  if (!value) return null;
  const payload = await verifySessionPayload(value);
  if (!payload || !payload.startsWith(SESSION_TAG)) return null;
  try {
    const bound = decodeJson(payload.slice(SESSION_TAG.length)) as Partial<BoundSession> | null;
    if (
      !bound || typeof bound !== 'object' ||
      typeof bound.h !== 'string' || !OPAQUE_43.test(bound.h) ||
      !boundId(bound.sid) ||
      !boundId(bound.pid) ||
      typeof bound.t !== 'string' || !CANONICAL_GUID.test(bound.t) ||
      typeof bound.o !== 'string' || !CANONICAL_GUID.test(bound.o) ||
      typeof bound.exp !== 'number' || !Number.isSafeInteger(bound.exp) || bound.exp <= 0
    ) {
      return null;
    }
    return { h: bound.h, sid: bound.sid, pid: bound.pid, t: bound.t, o: bound.o, exp: bound.exp };
  } catch {
    return null;
  }
}

/** HMAC of the handle under SESSION_SECRET: bound to the session, reveals nothing of it. */
async function csrfFor(handle: string): Promise<string> {
  const signed = await signSessionPayload(CSRF_TAG + handle);
  return signed.slice(signed.lastIndexOf('.') + 1);
}

function noStore(headers: Headers): Headers {
  headers.set('Cache-Control', 'no-store');
  return headers;
}

function json(body: unknown, status: number, cookies: string[] = [], extra: Record<string, string> = {}): Response {
  const headers = noStore(new Headers({ 'Content-Type': 'application/json', ...extra }));
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
}

/** A URL on the configured audience, or a path-only string when there is no configuration to trust. */
function redirect(location: URL | string, cookies: string[] = []): Response {
  const headers = noStore(new Headers({ Location: location.toString() }));
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

function unconfigured(): Response {
  return json({ error: 'Microsoft sign-in is not configured', code: new MicrosoftSignInNotConfiguredError().code }, 503);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Microsoft sign-in adapter. Throws at startup on any configuration
 * that could make it trust the wrong thing (see MicrosoftSignInConfig): with
 * `enabled: true`, a missing, empty or malformed `tenantId`, `issuer` or
 * `policy` throws whether or not a caller proof is set, and a live adapter
 * throws on a SESSION_SECRET under 32 characters. Dormant when no
 * configuration is passed at all, when `enabled !== true` (nothing else is
 * read), or when neither a service key nor `caller: 'managed-identity'` is
 * set (both together are refused). A dormant adapter calls nobody and
 * needs no SESSION_SECRET: `available` is false, every route answers 503
 * MICROSOFT_SIGNIN_UNCONFIGURED, `session()` and `sessionFromHeaders()` are
 * `unconfigured`, and `requireMicrosoftSession` answers 401 UNAUTHENTICATED to
 * an API request and a 303 to the path-only `/?returnTo=<path>` for a page
 * (never built from the request's Host).
 *
 * ```ts
 * // lib/microsoft.ts
 * export const microsoft = createMicrosoftSignIn({
 *   enabled: process.env.MICROSOFT_SIGNIN_ENABLED === 'true',
 *   caller: 'managed-identity',
 *   authCallerAudience: process.env.AUTH_MI_AUDIENCE,
 *   managedIdentityClientId: process.env.AUTH_MI_CLIENT_ID, // unset for system-assigned
 *   // A keyed app sets `serviceKey: process.env.FORIT_AUTH_APP_KEY` instead, never both.
 *   appId: 'for-example-web',
 *   workspaceHost: 'access.example.com',
 *   workspaceId: '<workspace guid>',
 *   audience: 'https://example.com',
 *   callback: 'https://example.com/api/auth/microsoft/callback',
 *   tenantId: '<tenant guid, lower case>',
 *   issuer: 'https://login.microsoftonline.com/<tenant guid>/v2.0',
 *   policy: { allow: [{ tenantId: '<tenant guid>', objectId: '<person object id>' }] },
 * });
 * // app/api/auth/microsoft/login/route.ts     export const GET = microsoft.routes.login;
 * // app/api/auth/microsoft/callback/route.ts  export const GET = microsoft.routes.callback;
 * // app/api/auth/microsoft/logout/route.ts    export const POST = microsoft.routes.logout;
 * // app/api/auth/microsoft/csrf/route.ts      export const GET = microsoft.routes.csrf;
 * ```
 */
export function createMicrosoftSignIn(config: MicrosoftSignInConfig): MicrosoftSignInHandlers {
  const resolved: ResolvedMicrosoftConfig = resolveMicrosoftConfig(config);
  if (!resolved.live) {
    return {
      available: false,
      cookieName: null,
      routes: {
        login: async () => unconfigured(),
        callback: async () => unconfigured(),
        logout: async () => unconfigured(),
        csrf: async () => unconfigured(),
      },
      session: async () => ({ status: 'unconfigured' }),
      sessionFromHeaders: async () => ({ status: 'unconfigured' }),
      requireMicrosoftSession: async (request, options = {}) => ({
        ok: false,
        response: deniedResponse(request, options, { status: 'unconfigured' }, null),
      }),
      signInHref: () => null,
    };
  }
  assertSessionSecret();
  assertMicrosoftSessionSecret();

  const cfg = resolved;
  const binding: MicrosoftExchangeBinding = {
    // Only the kind and the key or token source: the caller proof authenticates
    // the backend and never reaches a principal.
    proof: cfg.proof.kind === 'key' ? { kind: 'key', serviceKey: cfg.proof.serviceKey } : { kind: 'identity', token: cfg.proof.token },
    appId: cfg.appId,
    workspaceHost: cfg.workspaceHost,
    workspaceId: cfg.workspaceId,
    audience: cfg.audience,
    callback: cfg.callback,
    tenantId: cfg.tenantId,
    issuer: cfg.issuer,
    rpcTimeoutMs: cfg.rpcTimeoutMs,
  };
  const sessionName = `__Host-${cfg.appId}-ms-session`;
  const txName = `__Host-${cfg.appId}-ms-tx`;
  const clearSession = setCookie(sessionName, '', 0);
  const clearTx = setCookie(txName, '', 0);
  /** This request's answer, on its Request object; see session(). */
  const answered = new WeakMap<Request, { raw: string | undefined; state: Promise<MicrosoftSessionState> }>();
  const at = (path: string) => new URL(path, cfg.audience);
  const errorUrl = (code: string) => {
    const url = at(cfg.errorPath);
    url.searchParams.set('error', code);
    return url;
  };

  /**
   * The app's policy for one verified principal. `allowed` only when every
   * configured part passes: the principal is on `allow` (when there is one)
   * and `decide` (when there is one) resolved exactly `true`. A throw is
   * `error`. Nothing else admits.
   */
  async function admit(principal: MicrosoftPrincipal, phase: 'callback' | 'request'): Promise<'allowed' | 'denied' | 'error'> {
    const { allow, decide } = cfg.policy;
    if (allow && !allow.has(allowKey(principal.tenantId, principal.objectId))) return 'denied';
    if (decide) {
      let answer: unknown;
      try {
        answer = await decide({ principal, phase });
      } catch {
        console.error('[forit/auth/microsoft] the policy threw; nobody is admitted', { phase });
        return 'error';
      }
      if (answer !== true) return 'denied';
    }
    // resolveMicrosoftConfig refuses a policy with neither part, so one of them ran.
    return allow || decide ? 'allowed' : 'denied';
  }

  async function login(request: Request): Promise<Response> {
    const requested = new URL(request.url).searchParams.get('returnTo');
    const returnTo =
      requested && requested.length > MAX_RETURN_TO
        ? '/'
        : safeReturnTo(requested || cfg.defaultReturnTo, cfg.defaultReturnTo);
    const { tx, codeChallenge } = await newTransaction();
    const t = crypto.randomUUID();
    let txCookie = setCookie(txName, await sealTransaction({ ...tx, r: returnTo, t }), TX_MAX_AGE_SECONDS);
    if (new TextEncoder().encode(txCookie).length > MAX_SET_COOKIE_BYTES) {
      // Multi-byte characters can still outgrow the browser's limit inside 2048
      // characters. A dropped cookie would fail this sign-in, so keep '/' instead.
      txCookie = setCookie(txName, await sealTransaction({ ...tx, r: '/', t }), TX_MAX_AGE_SECONDS);
    }
    // Each parameter exactly once. state and nonce are UUIDs and the challenge
    // is 43 base64url characters, inside Auth's shapes.
    const authorize = new URL(`https://${cfg.workspaceHost}/api/access/apps/authorize`);
    authorize.search = new URLSearchParams({
      app: cfg.appId,
      callback: cfg.callback,
      state: tx.s,
      nonce: tx.n,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      provider: 'microsoft',
    }).toString();
    return redirect(authorize, [txCookie]);
  }

  async function callback(request: Request): Promise<Response> {
    // One sign-in per transaction: every answer clears the transaction cookie.
    const fail = (code: string) => redirect(errorUrl(code), [clearTx]);
    const params = new URL(request.url).searchParams;

    const states = params.getAll('state');
    const tx = await openTransaction(readCookie(request.headers, txName), cfg.defaultReturnTo);
    if (states.length !== 1 || !tx || !constantTimeEqual(states[0], tx.s)) {
      console.error("[forit/auth/microsoft] callback refused: the state does not match this browser's sign-in");
      return fail(MICROSOFT_SIGNIN_ERRORS.failed);
    }

    const errors = params.getAll('error');
    if (errors.length > 0) {
      const error = errors.length === 1 ? errors[0] : '';
      if (error === 'access_denied') return fail(MICROSOFT_SIGNIN_ERRORS.denied);
      if (error === 'temporarily_unavailable') return fail(MICROSOFT_SIGNIN_ERRORS.unavailable);
      return fail(MICROSOFT_SIGNIN_ERRORS.failed);
    }

    const codes = params.getAll('code');
    if (codes.length !== 1 || !OPAQUE_43.test(codes[0])) {
      console.error('[forit/auth/microsoft] callback refused: no single well-formed code');
      return fail(MICROSOFT_SIGNIN_ERRORS.failed);
    }

    // The app's one-use custody, before any redeem. Only exactly `true` goes on.
    if (cfg.consumeTransaction) {
      let consumed: unknown;
      try {
        consumed = await cfg.consumeTransaction(tx.t);
      } catch {
        console.error('[forit/auth/microsoft] callback refused: consumeTransaction threw; nothing was redeemed');
        return fail(MICROSOFT_SIGNIN_ERRORS.failed);
      }
      if (consumed !== true) {
        console.error('[forit/auth/microsoft] callback refused: the transaction was already used; nothing was redeemed');
        return fail(MICROSOFT_SIGNIN_ERRORS.failed);
      }
    }

    // Once, and never again for this code or this transaction: not after a
    // timeout, a dropped body or any other unclear answer. A second redeem of
    // a spent code is a replay, and Auth revokes the session the first made.
    const redeemed = await redeemMicrosoftCode(binding, codes[0], tx.v, tx.n);
    if (!redeemed.ok) {
      // A 201 whose answer failed its checks still made a session at Auth.
      if (redeemed.handle) await revokeMicrosoftHandle(binding, redeemed.handle);
      // An outage (503, a timeout, a network error, a retryable caller-token
      // failure) shows Microsoft as unavailable; every other failure is generic.
      return fail(redeemed.reason === 'unavailable' ? MICROSOFT_SIGNIN_ERRORS.unavailable : MICROSOFT_SIGNIN_ERRORS.failed);
    }

    // The bound expiry: the earlier of Auth's and the configured cap. It is
    // fixed here and never extended by a later verify.
    const now = Date.now();
    const boundExpiry = Math.min(redeemed.expiresAt, now + cfg.sessionMaxAge * 1000);
    const maxAge = Math.floor((boundExpiry - now) / 1000);
    if (maxAge <= 0) {
      await revokeMicrosoftHandle(binding, redeemed.handle);
      return fail(MICROSOFT_SIGNIN_ERRORS.failed);
    }
    const principal: MicrosoftPrincipal =
      redeemed.principal.expiresAt <= boundExpiry
        ? redeemed.principal
        : Object.freeze({ ...redeemed.principal, expiresAt: boundExpiry });

    const admission = await admit(principal, 'callback');
    if (admission !== 'allowed') {
      if (admission === 'denied') console.error('[forit/auth/microsoft] callback: the policy refused; the new session is revoked');
      await revokeMicrosoftHandle(binding, redeemed.handle);
      return fail(admission === 'denied' ? MICROSOFT_SIGNIN_ERRORS.denied : MICROSOFT_SIGNIN_ERRORS.failed);
    }

    const sealed = await sealSession({
      h: redeemed.handle,
      sid: principal.sessionId,
      pid: principal.principalId,
      t: principal.tenantId,
      o: principal.objectId,
      exp: boundExpiry,
    });
    let target = at(tx.r);
    if (target.origin !== cfg.audience) target = at('/');
    return redirect(target, [setCookie(sessionName, sealed, maxAge), clearTx]);
  }

  async function logout(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json({ error: 'Use POST', code: 'METHOD_NOT_ALLOWED' }, 405, [], { Allow: 'POST' });
    }
    // Same-origin only. Fetch metadata first, then the exact Origin, which a
    // sibling subdomain cannot forge (SameSite would let it through).
    if (request.headers.get('sec-fetch-site') === 'cross-site' || request.headers.get('origin') !== cfg.audience) {
      return json({ error: 'Cross-site logout blocked', code: 'CSRF_REJECTED' }, 403);
    }
    const bound = await openSession(readCookie(request.headers, sessionName));
    if (bound) {
      // The session's CSRF value, as every other state change needs. Without
      // it nothing is revoked and the cookie is kept.
      const sent = request.headers.get(MICROSOFT_CSRF_HEADER) ?? '';
      if (!constantTimeEqual(sent, await csrfFor(bound.h))) {
        return json({ error: 'Cross-site logout blocked', code: 'CSRF_REJECTED' }, 403);
      }
      // Never Microsoft's own sign-out, never Entra's end-session: only Auth's revoke.
      await revokeMicrosoftHandle(binding, bound.h);
    }
    // The cookie goes on every accepted logout, even when Auth cannot be reached.
    return redirect(at(cfg.signedOutPath), [clearSession]);
  }

  /** The one verify path: every reader below asks Auth through here. */
  async function verifyCookie(raw: string | undefined): Promise<MicrosoftSessionState> {
    if (!raw) return { status: 'signed_out' };
    const bound = await openSession(raw);
    if (!bound) return { status: 'signed_out', clearCookie: clearSession };
    // A cookie bound to another tenant than this configuration, or past its
    // bound expiry, is no session. Auth is not asked.
    if (bound.t !== cfg.tenantId || Date.now() >= bound.exp) return { status: 'signed_out', clearCookie: clearSession };

    const verified = await verifyMicrosoftHandle(binding, bound.h);
    if (verified.kind === 'ended') return { status: 'ended', clearCookie: clearSession };
    if (verified.kind === 'unavailable') return { status: 'unavailable' };
    if (verified.kind !== 'ok') return { status: 'failed' };

    // The answer must name the session and the person bound at sign-in. A
    // handle that now answers as anyone else admits nobody.
    const answer = verified.principal;
    if (
      answer.sessionId !== bound.sid ||
      answer.principalId !== bound.pid ||
      answer.tenantId !== bound.t ||
      answer.objectId !== bound.o
    ) {
      console.error(
        '[forit/auth/microsoft] verify: the answer names another session or person than this cookie was bound to; nobody is admitted',
      );
      return { status: 'failed' };
    }
    // The verify took time: the bound expiry may have passed meanwhile.
    if (Date.now() >= bound.exp) return { status: 'signed_out', clearCookie: clearSession };
    // The effective expiry is the earlier of the two; Auth's later one is not honoured.
    const principal: MicrosoftPrincipal =
      answer.expiresAt <= bound.exp ? answer : Object.freeze({ ...answer, expiresAt: bound.exp });

    const admission = await admit(principal, 'request');
    if (admission === 'error') return { status: 'failed' };
    const csrfToken = await csrfFor(bound.h);
    if (admission !== 'allowed') return { status: 'denied', csrfToken };
    return { status: 'signed_in', principal, csrfToken };
  }

  function session(request: Request): Promise<MicrosoftSessionState> {
    // One request, one verify: a route that asks twice with the same Request
    // asks Auth once. The answer goes with that object and is used only while
    // its cookie is the same. A new request is a new object and asks again.
    const raw = readCookie(request.headers, sessionName);
    const seen = answered.get(request);
    if (seen && seen.raw === raw) return seen.state;
    const state = verifyCookie(raw);
    answered.set(request, { raw, state });
    return state;
  }

  async function sessionFromHeaders(headers: CookieHeaderSource): Promise<MicrosoftSessionState> {
    // Anything that cannot be read as headers signs nobody in.
    if (typeof headers?.get !== 'function') return { status: 'signed_out' };
    return verifyCookie(readCookie(headers, sessionName));
  }

  function stateChangeAllowed(request: Request, csrfToken: string): boolean {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    const sent = request.headers.get(MICROSOFT_CSRF_HEADER) ?? '';
    return request.headers.get('origin') === cfg.audience && constantTimeEqual(sent, csrfToken);
  }

  async function requireMicrosoftSession(
    request: Request,
    options: RequireMicrosoftSessionOptions = {},
  ): Promise<RequireMicrosoftSessionResult> {
    const state = await session(request);
    if (state.status !== 'signed_in') {
      return { ok: false, response: deniedResponse(request, options, state, cfg) };
    }
    const api = options.api ?? new URL(request.url).pathname.startsWith('/api/');
    if (options.requireMfa) {
      return {
        ok: false,
        response: api
          ? json({ error: 'This route needs MFA, which this sign-in cannot prove', code: 'MFA_UNAVAILABLE' }, 403)
          : redirect(errorUrl(MICROSOFT_SIGNIN_ERRORS.mfaUnavailable)),
      };
    }
    if (!stateChangeAllowed(request, state.csrfToken)) {
      return { ok: false, response: json({ error: 'Cross-site request blocked', code: 'CSRF_REJECTED' }, 403) };
    }
    return { ok: true, principal: state.principal, csrfToken: state.csrfToken };
  }

  async function csrf(request: Request): Promise<Response> {
    if (request.method !== 'GET') {
      return json({ error: 'Use GET', code: 'METHOD_NOT_ALLOWED' }, 405, [], { Allow: 'GET' });
    }
    // Same-origin only: the value is for this site's own pages. A browser sends
    // Sec-Fetch-Site on every fetch, and Origin on a cross-origin one.
    const site = request.headers.get('sec-fetch-site');
    const origin = request.headers.get('origin');
    if ((site !== null && site !== 'same-origin') || (origin !== null && origin !== cfg.audience)) {
      return json({ error: 'Cross-site request blocked', code: 'CSRF_REJECTED' }, 403);
    }
    const result = await requireMicrosoftSession(request, { api: true });
    if (!result.ok) return result.response;
    return json({ csrfToken: result.csrfToken }, 200);
  }

  return {
    available: true,
    cookieName: sessionName,
    routes: { login, callback, logout, csrf },
    session,
    sessionFromHeaders,
    requireMicrosoftSession,
    signInHref: (returnTo) => microsoftSignInHref(cfg.loginPath, returnTo),
  };
}

/** The answer for a request `session()` did not admit. */
function deniedResponse(
  request: Request,
  options: RequireMicrosoftSessionOptions,
  state: Exclude<MicrosoftSessionState, { status: 'signed_in' }>,
  cfg: Extract<ResolvedMicrosoftConfig, { live: true }> | null,
): Response {
  const url = new URL(request.url);
  const api = options.api ?? url.pathname.startsWith('/api/');
  const cookies = 'clearCookie' in state && state.clearCookie ? [state.clearCookie] : [];
  // A live adapter redirects on its configured audience. A dormant one has no
  // origin it can trust (the request's comes from its Host header), so it
  // sends a path-only Location that the browser resolves on the page it is on.
  const target = (path: string, name: string, value: string): URL | string => {
    const to = new URL(path, cfg?.audience ?? PATH_ONLY_BASE);
    to.searchParams.set(name, value);
    return cfg ? to : to.pathname + to.search;
  };

  if (state.status === 'denied') {
    // Signed in at forit-Auth, refused by the app's policy. The cookie is kept.
    if (api) return json({ error: 'Not allowed', code: 'MICROSOFT_SIGNIN_DENIED' }, 403);
    return redirect(target(cfg?.errorPath ?? '/', 'error', MICROSOFT_SIGNIN_ERRORS.denied));
  }

  if (state.status === 'unavailable' || state.status === 'failed') {
    const unavailable = state.status === 'unavailable';
    if (api) {
      return json(
        unavailable
          ? { error: 'Sign-in is unavailable', code: 'MICROSOFT_SIGNIN_UNAVAILABLE' }
          : { error: 'Sign-in failed', code: 'MICROSOFT_SIGNIN_FAILED' },
        503,
        cookies,
        unavailable ? { 'Retry-After': '5' } : {},
      );
    }
    const code = unavailable ? MICROSOFT_SIGNIN_ERRORS.unavailable : MICROSOFT_SIGNIN_ERRORS.failed;
    return redirect(target(cfg?.errorPath ?? '/', 'error', code), cookies);
  }

  if (api) return json({ error: 'Not authenticated', code: 'UNAUTHENTICATED' }, 401, cookies);
  return redirect(target(cfg?.signInPath ?? '/', 'returnTo', safeReturnTo(url.pathname + url.search, '/')), cookies);
}
