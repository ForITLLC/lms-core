// ============================================================================
// @foritllc/auth/google - Optional Google sign-in through forit-Auth (0.13.0)
//
// The consumer half of ADR 0022, built to the for-Common consumer contract
// (docs/plans/2026-10-28-google-sign-in-consumer-contract.md, revision 6) and
// forit-Auth's app sign-in exchange (for-Auth docs/plans/2026-10-28-app-sign-
// in-exchange.md, cited PR99). Opt-in and OFF by default: nothing here changes
// the Entra routes, cookie, middleware or helpers in `@foritllc/auth`.
//
//   login     mints state, nonce and a PKCE S256 verifier in a signed
//             `__Host-` transaction cookie (10 minutes) and sends the browser
//             to forit-Auth's authorize route on the workspace host, with
//             provider=google.
//   callback  checks state against that cookie, redeems the code once,
//             server to server, checks Auth's answer against configuration,
//             runs the opt-in hook, and sets `__Host-<appId>-session`, which
//             holds Auth's opaque handle and nothing else.
//   session   verifies the handle with forit-Auth on EVERY request and keeps
//             no positive answer past it (R-C1). Fails closed: Auth
//             unavailable is 503, never a stale or fallback identity.
//   logout    same-origin POST only; revokes the handle, clears the cookie.
//
// No Google client, secret, token or library is in the app: forit-Auth holds
// them. Microsoft sign-in stays on the Entra routes and never depends on this.
// Edge-safe: web Request/Response and Web Crypto only, no next/* import.
// ============================================================================

import {
  type GoogleSignInConfig,
  type ResolvedGoogleConfig,
  AUTH_ORIGIN,
  GOOGLE_ISSUER,
  GoogleSignInNotConfiguredError,
  assertGoogleSessionSecret,
  resolveGoogleConfig,
} from './google-config.js';
import { type ExchangeBinding, OPAQUE_43, redeemCode, revokeHandle, verifyHandle } from './google-exchange.js';
import { createLinkedGroupReader } from './google-groups.js';
import { TX_MAX_AGE_SECONDS, constantTimeEqual, newTransaction } from './oauth-transaction.js';
import type { GooglePrincipal } from './principal.js';
import { safeReturnTo } from './return-to.js';
import { assertSessionSecret, signSessionPayload, verifySessionPayload } from './session-crypto.js';

export { AUTH_ORIGIN, GOOGLE_ISSUER, GoogleSignInNotConfiguredError };
export type {
  DirectoryObjectStatus,
  GoogleSignedInHook,
  GoogleSignInConfig,
  LinkedDirectoryConfig,
  LinkedDirectoryTenant,
} from './google-config.js';
export { entraPrincipal, isGooglePrincipal } from './principal.js';
export type { DirectoryLink, EntraPrincipal, GooglePrincipal, SignedInPrincipal } from './principal.js';

/** The `?error=` codes the adapter sends a browser to `errorPath` with. */
export const GOOGLE_SIGNIN_ERRORS = Object.freeze({
  /** forit-Auth answered `access_denied`, or the app's hook refused. "Not allowed." */
  denied: 'google_denied',
  /** forit-Auth answered `temporarily_unavailable`, or it could not be reached. Show Google as unavailable. */
  unavailable: 'google_unavailable',
  /** Anything else. A generic failure; the person may start a new sign-in. */
  failed: 'google_failed',
  /** A route marked as needing MFA or a recent sign-in: Auth keeps no verified MFA claim (contract §5). */
  mfaUnavailable: 'google_mfa_unavailable',
} as const);

/** The header a state-changing request carries the session's CSRF value in. */
export const GOOGLE_CSRF_HEADER = 'x-forit-csrf';

/** Domain-separation tags under SESSION_SECRET: Entra uses `tx:` and plain base64 JSON. */
const TX_TAG = 'gtx:';
const SESSION_TAG = 'gs:';
const CSRF_TAG = 'gcsrf:';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Only to build a path and query; never sent. */
const PATH_ONLY_BASE = 'https://same-origin.invalid';
const HOOK_ERROR = /^[a-z][a-z0-9_]{0,63}$/;

/** A longer `returnTo` is dropped for `/`, not stored. */
const MAX_RETURN_TO = 2048;
/** Browsers drop a cookie over about 4096 bytes; the transaction cookie's whole Set-Cookie line stays inside it. */
const MAX_SET_COOKIE_BYTES = 4096;

/** What one request's verify found. Only `signed_in` admits anyone. */
export type GoogleSessionState =
  | { status: 'signed_in'; principal: GooglePrincipal; csrfToken: string }
  /** The adapter is dormant: no request was made. */
  | { status: 'unconfigured' }
  /** No usable Google cookie. `clearCookie` is set when a bad one should go. */
  | { status: 'signed_out'; clearCookie?: string }
  /** forit-Auth answered 401 invalid_session: the session ended there. */
  | { status: 'ended'; clearCookie: string }
  /** forit-Auth answered 503, or did not answer. The cookie is kept. */
  | { status: 'unavailable' }
  /** Any other answer. Nobody is admitted; the cookie is kept. */
  | { status: 'failed' };

export interface RequireGoogleSessionOptions {
  /** Answer as an API (JSON 401/403/503) instead of redirecting. Default: the path starts with `/api/`. */
  api?: boolean;
  /**
   * The route needs MFA or a recent sign-in. forit-Auth keeps no verified
   * `auth_time`, `amr` or `acr` (PR99 §8), so every Google principal is refused.
   */
  requireMfa?: boolean;
}

export type RequireGoogleSessionResult =
  | { ok: true; principal: GooglePrincipal; csrfToken: string }
  | { ok: false; response: Response };

export interface GoogleSignInHandlers {
  /** True when the adapter is live. Show the Google button as unavailable otherwise. */
  readonly available: boolean;
  /** The session cookie's name, `__Host-<appId>-session`, or null when dormant. */
  readonly cookieName: string | null;
  routes: {
    login(request: Request): Promise<Response>;
    callback(request: Request): Promise<Response>;
    logout(request: Request): Promise<Response>;
  };
  /** Verify this request's Google cookie with forit-Auth. One call per request; nothing kept. */
  session(request: Request): Promise<GoogleSessionState>;
  /** `session()` plus the answer to send when it does not admit, the CSRF check and the MFA rule. */
  requireGoogleSession(request: Request, options?: RequireGoogleSessionOptions): Promise<RequireGoogleSessionResult>;
  /**
   * The linked principal's group ids, or null (hide every gated surface and
   * refuse its API routes). Always null unless `linkedDirectory` is
   * configured. Pass only the principal THIS request's verify returned:
   * any object this adapter's `session()` did not return (a hand-built one, a
   * JSON or spread copy, another adapter's, the `onSignedIn` hook's) gets null.
   * That check is provenance only; freshness comes from verifying every request.
   */
  linkedGroupIds(principal: GooglePrincipal | null | undefined): Promise<string[] | null>;
  /** The href for a Google button, or null when dormant. */
  signInHref(returnTo?: string): string | null;
}

/** `loginPath?returnTo=` for a Google button, same-origin paths only. */
export function googleSignInHref(loginPath = '/api/auth/google/login', returnTo?: string): string {
  const path = safeReturnTo(loginPath, '/api/auth/google/login');
  const back = returnTo === undefined ? '' : safeReturnTo(returnTo, '');
  return back ? `${path}?returnTo=${encodeURIComponent(back)}` : path;
}

// ---------------------------------------------------------------------------
// Encoding and cookies (edge-safe: no Buffer)
// ---------------------------------------------------------------------------

function encodeJson(value: unknown): string {
  let bin = '';
  for (const b of new TextEncoder().encode(JSON.stringify(value))) bin += String.fromCharCode(b);
  return btoa(bin);
}

function decodeJson(b64: string): unknown {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setCookie(name: string, value: string, maxAgeSec: number): string {
  // Host-only: `__Host-` forbids Domain and needs Secure and Path=/. Lax, not
  // Strict: the callback is a top-level navigation from the workspace host.
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

interface GoogleTransaction {
  s: string;
  n: string;
  v: string;
  exp: number;
  r: string;
}

async function sealTransaction(tx: GoogleTransaction): Promise<string> {
  return signSessionPayload(TX_TAG + encodeJson(tx));
}

async function openTransaction(value: string | undefined, fallbackReturnTo: string): Promise<GoogleTransaction | null> {
  if (!value) return null;
  const payload = await verifySessionPayload(value);
  if (!payload || !payload.startsWith(TX_TAG)) return null;
  try {
    const tx = decodeJson(payload.slice(TX_TAG.length)) as Partial<GoogleTransaction> | null;
    if (
      !tx || typeof tx !== 'object' ||
      typeof tx.s !== 'string' || !tx.s ||
      typeof tx.n !== 'string' || !tx.n ||
      typeof tx.v !== 'string' || !tx.v ||
      typeof tx.exp !== 'number' || tx.exp < Date.now()
    ) {
      return null;
    }
    return { s: tx.s, n: tx.n, v: tx.v, exp: tx.exp, r: safeReturnTo(tx.r, fallbackReturnTo) };
  } catch {
    return null;
  }
}

async function sealHandle(handle: string): Promise<string> {
  return signSessionPayload(SESSION_TAG + handle);
}

async function openHandle(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const payload = await verifySessionPayload(value);
  if (!payload || !payload.startsWith(SESSION_TAG)) return null;
  const handle = payload.slice(SESSION_TAG.length);
  return OPAQUE_43.test(handle) ? handle : null;
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
  return json({ error: 'Google sign-in is not configured', code: new GoogleSignInNotConfiguredError().code }, 503);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the Google sign-in adapter. Throws at startup on any configuration
 * that could make it trust the wrong thing (see GoogleSignInConfig), and, when
 * live, on a SESSION_SECRET under 32 characters. Dormant unless
 * `enabled === true` and a service key is set. A dormant adapter calls nobody
 * and needs no SESSION_SECRET: `available` is false, `routes.login`,
 * `routes.callback` and `routes.logout` answer 503 GOOGLE_SIGNIN_UNCONFIGURED,
 * `session()` is `unconfigured`, and `requireGoogleSession` answers 401
 * UNAUTHENTICATED to an API request and a 303 to the path-only
 * `/?returnTo=<path>` for a page (never built from the request's Host).
 *
 * ```ts
 * // lib/google.ts
 * export const google = createGoogleSignIn({
 *   enabled: process.env.GOOGLE_SIGNIN_ENABLED === 'true',
 *   serviceKey: process.env.FORIT_AUTH_APP_KEY,
 *   appId: 'for-example-web',
 *   workspaceHost: 'access.example.com',
 *   workspaceId: '<workspace guid>',
 *   audience: 'https://example.com',
 *   callback: 'https://example.com/api/auth/google/callback',
 * });
 * // app/api/auth/google/login/route.ts     export const GET = google.routes.login;
 * // app/api/auth/google/callback/route.ts  export const GET = google.routes.callback;
 * // app/api/auth/google/logout/route.ts    export const POST = google.routes.logout;
 * ```
 */
export function createGoogleSignIn(config: GoogleSignInConfig): GoogleSignInHandlers {
  const resolved: ResolvedGoogleConfig = resolveGoogleConfig(config);
  if (!resolved.live) {
    return {
      available: false,
      cookieName: null,
      routes: { login: async () => unconfigured(), callback: async () => unconfigured(), logout: async () => unconfigured() },
      session: async () => ({ status: 'unconfigured' }),
      requireGoogleSession: async (request, options = {}) => ({
        ok: false,
        response: deniedResponse(request, options, { status: 'unconfigured' }, null),
      }),
      linkedGroupIds: async () => null,
      signInHref: () => null,
    };
  }
  assertSessionSecret();
  assertGoogleSessionSecret();

  const cfg = resolved;
  const groups = createLinkedGroupReader(cfg.linked);
  const binding: ExchangeBinding = {
    serviceKey: cfg.serviceKey,
    appId: cfg.appId,
    workspaceHost: cfg.workspaceHost,
    workspaceId: cfg.workspaceId,
    audience: cfg.audience,
    callback: cfg.callback,
    rpcTimeoutMs: cfg.rpcTimeoutMs,
  };
  const sessionName = `__Host-${cfg.appId}-session`;
  const txName = `__Host-${cfg.appId}-google-tx`;
  const clearSession = setCookie(sessionName, '', 0);
  const clearTx = setCookie(txName, '', 0);
  const at = (path: string) => new URL(path, cfg.audience);
  const errorUrl = (code: string) => {
    const url = at(cfg.errorPath);
    url.searchParams.set('error', code);
    return url;
  };

  async function login(request: Request): Promise<Response> {
    const requested = new URL(request.url).searchParams.get('returnTo');
    const returnTo =
      requested && requested.length > MAX_RETURN_TO
        ? '/'
        : safeReturnTo(requested || cfg.defaultReturnTo, cfg.defaultReturnTo);
    const { tx, codeChallenge } = await newTransaction();
    let txCookie = setCookie(txName, await sealTransaction({ ...tx, r: returnTo }), TX_MAX_AGE_SECONDS);
    if (new TextEncoder().encode(txCookie).length > MAX_SET_COOKIE_BYTES) {
      // Multi-byte characters can still outgrow the browser's limit inside 2048
      // characters. A dropped cookie would fail this sign-in, so keep '/' instead.
      txCookie = setCookie(txName, await sealTransaction({ ...tx, r: '/' }), TX_MAX_AGE_SECONDS);
    }
    // PR99 §3.1: each parameter exactly once. state and nonce are UUIDs and the
    // challenge is 43 base64url characters, inside Auth's shapes (contract §4).
    const authorize = new URL(`https://${cfg.workspaceHost}/api/access/apps/authorize`);
    authorize.search = new URLSearchParams({
      app: cfg.appId,
      callback: cfg.callback,
      state: tx.s,
      nonce: tx.n,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      provider: 'google',
    }).toString();
    return redirect(authorize, [txCookie]);
  }

  async function callback(request: Request): Promise<Response> {
    // One sign-in per transaction: every answer clears the transaction cookie.
    const fail = (code: string) => redirect(errorUrl(code), [clearTx]);
    const params = new URL(request.url).searchParams;

    const states = params.getAll('state');
    const tx = await openTransaction(readCookie(request, txName), cfg.defaultReturnTo);
    if (states.length !== 1 || !tx || !constantTimeEqual(states[0], tx.s)) {
      console.error("[forit/auth/google] callback refused: the state does not match this browser's sign-in");
      return fail(GOOGLE_SIGNIN_ERRORS.failed);
    }

    const errors = params.getAll('error');
    if (errors.length > 0) {
      const error = errors.length === 1 ? errors[0] : '';
      if (error === 'access_denied') return fail(GOOGLE_SIGNIN_ERRORS.denied);
      if (error === 'temporarily_unavailable') return fail(GOOGLE_SIGNIN_ERRORS.unavailable);
      return fail(GOOGLE_SIGNIN_ERRORS.failed);
    }

    const codes = params.getAll('code');
    if (codes.length !== 1 || !OPAQUE_43.test(codes[0])) {
      console.error('[forit/auth/google] callback refused: no single well-formed code');
      return fail(GOOGLE_SIGNIN_ERRORS.failed);
    }

    // Once. A second redeem of this code is a replay (PR99 §4.1).
    const redeemed = await redeemCode(binding, codes[0], tx.v, tx.n);
    if (!redeemed.ok) return fail(GOOGLE_SIGNIN_ERRORS.failed);

    if (cfg.onSignedIn) {
      let decision: Awaited<ReturnType<NonNullable<typeof cfg.onSignedIn>>>;
      try {
        decision = await cfg.onSignedIn(redeemed.principal, request);
      } catch {
        console.error('[forit/auth/google] callback: the onSignedIn hook threw; the new session is revoked');
        await revokeHandle(binding, redeemed.handle);
        return fail(GOOGLE_SIGNIN_ERRORS.failed);
      }
      // Admit only on nothing or exactly `{ allowed: true }`; anything else
      // (true, false, null, 0, '', a string, `{ error }`) refuses.
      const answer: unknown = decision;
      const isObject = typeof answer === 'object' && answer !== null;
      const allowed = answer === undefined || (isObject && (answer as { allowed?: unknown }).allowed === true);
      if (!allowed) {
        await revokeHandle(binding, redeemed.handle);
        // Only an explicit `{ allowed: false, error }` names its own code.
        const own = isObject && (answer as { allowed?: unknown }).allowed === false ? (answer as { error?: unknown }).error : undefined;
        return fail(typeof own === 'string' && HOOK_ERROR.test(own) ? own : GOOGLE_SIGNIN_ERRORS.denied);
      }
    }

    const maxAge = Math.min(cfg.sessionMaxAge, Math.floor((redeemed.expiresAt - Date.now()) / 1000));
    if (maxAge <= 0) {
      await revokeHandle(binding, redeemed.handle);
      return fail(GOOGLE_SIGNIN_ERRORS.failed);
    }

    let target = at(tx.r);
    if (target.origin !== cfg.audience) target = at('/');
    return redirect(target, [setCookie(sessionName, await sealHandle(redeemed.handle), maxAge), clearTx]);
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
    const handle = await openHandle(readCookie(request, sessionName));
    // The cookie goes on every outcome, even when Auth cannot be reached.
    // Never Google's revoke, never Entra's end-session (contract §5).
    if (handle) await revokeHandle(binding, handle);
    return redirect(at(cfg.signedOutPath), [clearSession]);
  }

  async function session(request: Request): Promise<GoogleSessionState> {
    const raw = readCookie(request, sessionName);
    if (!raw) return { status: 'signed_out' };
    const handle = await openHandle(raw);
    if (!handle) return { status: 'signed_out', clearCookie: clearSession };
    const verified = await verifyHandle(binding, handle);
    switch (verified.kind) {
      case 'ok':
        return { status: 'signed_in', principal: groups.admit(verified.principal), csrfToken: await csrfFor(handle) };
      case 'ended':
        return { status: 'ended', clearCookie: clearSession };
      case 'unavailable':
        return { status: 'unavailable' };
      default:
        return { status: 'failed' };
    }
  }

  function stateChangeAllowed(request: Request, csrfToken: string): boolean {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
    const sent = request.headers.get(GOOGLE_CSRF_HEADER) ?? '';
    return request.headers.get('origin') === cfg.audience && constantTimeEqual(sent, csrfToken);
  }

  async function requireGoogleSession(
    request: Request,
    options: RequireGoogleSessionOptions = {},
  ): Promise<RequireGoogleSessionResult> {
    const state = await session(request);
    if (state.status !== 'signed_in') {
      return { ok: false, response: deniedResponse(request, options, state, cfg) };
    }
    const api = options.api ?? new URL(request.url).pathname.startsWith('/api/');
    if (options.requireMfa) {
      return {
        ok: false,
        response: api
          ? json({ error: 'This route needs MFA, which Google sign-in cannot prove', code: 'MFA_UNAVAILABLE' }, 403)
          : redirect(errorUrl(GOOGLE_SIGNIN_ERRORS.mfaUnavailable)),
      };
    }
    if (!stateChangeAllowed(request, state.csrfToken)) {
      return { ok: false, response: json({ error: 'Cross-site request blocked', code: 'CSRF_REJECTED' }, 403) };
    }
    return { ok: true, principal: state.principal, csrfToken: state.csrfToken };
  }

  return {
    available: true,
    cookieName: sessionName,
    routes: { login, callback, logout },
    session,
    requireGoogleSession,
    linkedGroupIds: (principal) => groups.read(principal),
    signInHref: (returnTo) => googleSignInHref(cfg.loginPath, returnTo),
  };
}

/** The answer for a request `session()` did not admit. */
function deniedResponse(
  request: Request,
  options: RequireGoogleSessionOptions,
  state: Exclude<GoogleSessionState, { status: 'signed_in' }>,
  cfg: Extract<ResolvedGoogleConfig, { live: true }> | null,
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

  if (state.status === 'unavailable' || state.status === 'failed') {
    const unavailable = state.status === 'unavailable';
    if (api) {
      return json(
        unavailable
          ? { error: 'Sign-in is unavailable', code: 'GOOGLE_SIGNIN_UNAVAILABLE' }
          : { error: 'Sign-in failed', code: 'GOOGLE_SIGNIN_FAILED' },
        503,
        cookies,
        unavailable ? { 'Retry-After': '5' } : {},
      );
    }
    const code = unavailable ? GOOGLE_SIGNIN_ERRORS.unavailable : GOOGLE_SIGNIN_ERRORS.failed;
    return redirect(target(cfg?.errorPath ?? '/', 'error', code), cookies);
  }

  if (api) return json({ error: 'Not authenticated', code: 'UNAUTHENTICATED' }, 401, cookies);
  return redirect(target(cfg?.signInPath ?? '/', 'returnTo', safeReturnTo(url.pathname + url.search, '/')), cookies);
}
