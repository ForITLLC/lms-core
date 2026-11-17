// ============================================================================
// @foritllc/auth - Client assertion (0.9.0)
// ============================================================================
//
// An app can redeem the authorization code with a client assertion instead of
// a client secret. The assertion that matters here is a managed-identity token
// for `api://AzureADTokenExchange`: the shared sign-in registration holds a
// federated identity credential that trusts the app's own managed identity, so
// the app has no secret to leak or rotate (forit-sign-in-client.md rule 3).

/** The `client_assertion_type` Entra expects for a JWT client assertion. */
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

/** The audience a managed-identity token must carry for a federated credential. */
export const TOKEN_EXCHANGE_AUDIENCE = 'api://AzureADTokenExchange';

/**
 * The host's managed-identity endpoint refused the token request. `status` is
 * its HTTP status, kept as a value so a caller can tell a throttle (429) from
 * a misconfiguration (400) without reading the message.
 */
export class ManagedIdentityTokenError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ManagedIdentityTokenError';
    this.status = status;
  }
}

/** Refresh a cached assertion this long before it expires. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface ManagedIdentityAssertionOptions {
  /**
   * Client id of a user-assigned managed identity. Omit to use the app's
   * system-assigned identity. Either way the identity is assigned to this app
   * alone (rule 3).
   */
  clientId?: string;
  /** Default: `process.env.IDENTITY_ENDPOINT`, read on each token request. */
  endpoint?: string;
  /** Default: `process.env.IDENTITY_HEADER`, read on each token request. */
  header?: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A `clientAssertion` source backed by the managed identity of an App
 * Service, Functions or Container Apps host: `GET $IDENTITY_ENDPOINT` with
 * `X-IDENTITY-HEADER: $IDENTITY_HEADER`, `resource=api://AzureADTokenExchange`,
 * `api-version=2019-08-01`. The token is cached until five minutes before it
 * expires.
 *
 * The environment is read when a sign-in redeems its code, not when the app
 * starts, so `next build` runs without it. A host with no managed identity
 * throws at that point, and the callback answers `callback_failed`. It never
 * falls back to a secret.
 */
export function managedIdentityClientAssertion(
  options: ManagedIdentityAssertionOptions = {}
): () => Promise<string> {
  let cached: { token: string; refreshAt: number } | undefined;

  return async () => {
    if (cached && Date.now() < cached.refreshAt) return cached.token;

    const endpoint = options.endpoint ?? process.env.IDENTITY_ENDPOINT;
    const header = options.header ?? process.env.IDENTITY_HEADER;
    if (!endpoint || !header) {
      throw new Error(
        '[forit/auth] managedIdentityClientAssertion: IDENTITY_ENDPOINT and IDENTITY_HEADER are not set. ' +
          'Turn on a managed identity for this app and give the shared sign-in registration a ' +
          'federated credential that trusts it (forit-sign-in-client.md rule 3).'
      );
    }

    const url = new URL(endpoint);
    url.searchParams.set('resource', TOKEN_EXCHANGE_AUDIENCE);
    url.searchParams.set('api-version', '2019-08-01');
    if (options.clientId) url.searchParams.set('client_id', options.clientId);

    const res = await (options.fetch ?? fetch)(url, { headers: { 'X-IDENTITY-HEADER': header } });
    if (!res.ok) {
      // The body is not logged: the status says enough, and a token
      // endpoint's body is no place to start printing from.
      throw new ManagedIdentityTokenError('[forit/auth] managed identity token request failed', res.status);
    }
    const body = (await res.json()) as { access_token?: unknown; expires_on?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token === '') {
      throw new Error('[forit/auth] managed identity token response has no access_token');
    }

    // expires_on is epoch seconds (a string on api-version 2019-08-01). An
    // unreadable value caches nothing.
    const expiresOn = Number(body.expires_on);
    cached = Number.isFinite(expiresOn)
      ? { token: body.access_token, refreshAt: expiresOn * 1000 - REFRESH_MARGIN_MS }
      : undefined;
    return body.access_token;
  };
}

// ============================================================================
// The Auth caller token (0.18.0)
// ============================================================================
//
// An app's server proves who it is to forit-Auth's session routes (Google
// sign-in redeem, verify and revoke) with a token from its own managed
// identity, in place of a `fau_` key: nothing to store, grant or rotate. The
// token is for Auth's caller app (`AUTH_MI_AUDIENCE`, a GUID) and is sent as
// `Authorization: Bearer <token>`; Auth checks it (for-Auth's contract,
// common-auth-caller-token-helper-contract-20261103.md). The helper never
// decodes the token, never logs it and never writes it anywhere but memory.

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** Microsoft Graph's app id: a first-party resource, never Auth's caller app. */
const MICROSOFT_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
/** VMs, scale sets and AKS: the instance metadata service. */
// metered-call-guard: not-metered — Azure's host-local managed identity token
// endpoints issue tokens without a per-request charge; no paid vendor API is called.
const IMDS_TOKEN_ENDPOINT = 'http://169.254.169.254/metadata/identity/oauth2/token';
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/** The largest token Auth accepts. JWT_SHAPE is ASCII, so characters are bytes. */
const MAX_TOKEN_BYTES = 16384;
const DEFAULT_CALLER_TIMEOUT_MS = 5000;

export type AuthCallerTokenErrorCode =
  | 'AUTH_CALLER_NOT_CONFIGURED'
  | 'AUTH_CALLER_NO_IDENTITY'
  | 'AUTH_CALLER_TOKEN_UNAVAILABLE';

const AUTH_CALLER_MESSAGES: Record<AuthCallerTokenErrorCode, string> = {
  AUTH_CALLER_NOT_CONFIGURED: '[forit/auth] Auth caller token: the audience or client id is not a GUID',
  AUTH_CALLER_NO_IDENTITY: '[forit/auth] Auth caller token: this host has no complete managed identity endpoint',
  AUTH_CALLER_TOKEN_UNAVAILABLE: '[forit/auth] Auth caller token request failed',
};

/**
 * No Auth caller token. The message is fixed text: it never holds the token,
 * `IDENTITY_HEADER`, the endpoint URL, the response body or an upstream
 * message, and there is no `cause` (a fetch error can carry the URL).
 *
 * - `AUTH_CALLER_NOT_CONFIGURED`: the audience, client id or timeout failed
 *   the input checks. Not retryable.
 * - `AUTH_CALLER_NO_IDENTITY`: only one of `IDENTITY_ENDPOINT` and
 *   `IDENTITY_HEADER` is set, or the endpoint is not an http(s) URL. Not retryable.
 * - `AUTH_CALLER_TOKEN_UNAVAILABLE`: retryable after a network error, a
 *   timeout or status 404, 410, 429 or 5xx (Microsoft's IMDS retry guidance);
 *   not retryable after any other status, a body that is not JSON, a missing
 *   or misshapen `access_token`, or a token that has already expired.
 */
export class AuthCallerTokenError extends Error {
  readonly code: AuthCallerTokenErrorCode;
  /** The identity endpoint's HTTP status, when there was one. */
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(code: AuthCallerTokenErrorCode, status: number | null = null, retryable = false, message = AUTH_CALLER_MESSAGES[code]) {
    super(message);
    this.name = 'AuthCallerTokenError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export interface AuthCallerTokenOptions {
  /**
   * Auth's caller app client id: the same GUID as AUTH_MI_AUDIENCE on forit-auth-web
   * Required deployment configuration; there is no default.
   */
  audience: string;
  /** Client id of a user-assigned identity (the app's AUTH_MI_CLIENT_ID). Omit for the system-assigned identity. */
  clientId?: string;
  /** Per token request, in ms, 100 to 30000. Default 5000. The Google adapter passes its rpcTimeoutMs. */
  timeoutMs?: number;
}

export interface AuthCallerTokenSourceOptions extends AuthCallerTokenOptions {
  /** Default: the global `fetch`, looked up on each request. */
  fetch?: typeof fetch;
  /** Epoch ms. Default `Date.now`. */
  now?: () => number;
  /** Default: `process.env`, read on every fetch (an empty object where there is no `process`). */
  env?: () => Record<string, string | undefined>;
}

/**
 * Auth's caller audience in lower case, or null when it is not exactly a GUID
 * (no surrounding spaces, never an `api://` name) or is Microsoft Graph. Used
 * by the Google adapter to name the bad setting at startup.
 */
export function authCallerAudienceOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !GUID.test(raw)) return null;
  const audience = raw.toLowerCase();
  return audience === MICROSOFT_GRAPH_APP_ID ? null : audience;
}

/**
 * A user-assigned identity's client id in lower case; `null` for blank or
 * absent (the system-assigned identity); `undefined` when it is set but not a GUID.
 */
export function identityClientIdOf(raw: unknown): string | null | undefined {
  if (raw === undefined || raw === null || (typeof raw === 'string' && !raw.trim())) return null;
  return typeof raw === 'string' && GUID.test(raw) ? raw.toLowerCase() : undefined;
}

interface CheckedCallerOptions {
  audience: string;
  clientId: string | null;
  timeoutMs: number;
}

function checkCallerOptions(options: AuthCallerTokenOptions): CheckedCallerOptions {
  const audience = authCallerAudienceOf(options?.audience);
  const clientId = identityClientIdOf(options?.clientId);
  if (audience === null || clientId === undefined) {
    throw new AuthCallerTokenError('AUTH_CALLER_NOT_CONFIGURED');
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLER_TIMEOUT_MS;
  if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new AuthCallerTokenError(
      'AUTH_CALLER_NOT_CONFIGURED',
      null,
      false,
      '[forit/auth] Auth caller token: timeoutMs must be an integer from 100 to 30000',
    );
  }
  return { audience, clientId, timeoutMs };
}

/** Edge-safe: there may be no `process` at all. */
function processEnv(): Record<string, string | undefined> {
  return typeof process !== 'undefined' && process.env ? process.env : {};
}

const isSet = (value: string | undefined): value is string => typeof value === 'string' && value.trim() !== '';

/** Epoch seconds as an integer, from a number or a string of digits; null when unreadable. */
function epochSeconds(value: unknown): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string' && /^\d{1,15}$/.test(value)) return Number(value);
  return null;
}

const unavailable = (status: number | null, retryable: boolean) =>
  new AuthCallerTokenError('AUTH_CALLER_TOKEN_UNAVAILABLE', status, retryable);

/** Query parameters that pick a managed identity; only `client_id`, and only when explicit, is ever sent. */
const IDENTITY_SELECTORS = new Set(['client_id', 'principal_id', 'object_id', 'mi_res_id', 'msi_res_id']);

/** One token request; the fetch is per (audience, client id) and uses the timeout it is given. */
type TokenFetcher = (timeoutMs: number) => Promise<string>;

function tokenFetcher(
  checked: Pick<CheckedCallerOptions, 'audience' | 'clientId'>,
  seams: Pick<AuthCallerTokenSourceOptions, 'fetch' | 'now' | 'env'>,
): TokenFetcher {
  const now = seams.now ?? Date.now;
  const env = seams.env ?? processEnv;
  let cached: { token: string; refreshAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function request(timeoutMs: number): Promise<string> {
    // Read on every fetch, never at startup: `next build` has no identity,
    // and the platform rotates IDENTITY_HEADER.
    const vars = env() ?? {};
    const endpoint = vars.IDENTITY_ENDPOINT;
    const header = vars.IDENTITY_HEADER;
    let url: URL;
    let headers: Record<string, string>;
    if (isSet(endpoint) && isSet(header)) {
      // App Service, Functions, Container Apps.
      try {
        url = new URL(endpoint);
      } catch {
        throw new AuthCallerTokenError('AUTH_CALLER_NO_IDENTITY');
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AuthCallerTokenError('AUTH_CALLER_NO_IDENTITY');
      url.searchParams.set('resource', checked.audience);
      url.searchParams.set('api-version', '2019-08-01');
      headers = { 'X-IDENTITY-HEADER': header };
    } else if (isSet(endpoint) || isSet(header)) {
      // Half configured: never guess IMDS.
      throw new AuthCallerTokenError('AUTH_CALLER_NO_IDENTITY');
    } else {
      url = new URL(IMDS_TOKEN_ENDPOINT);
      url.searchParams.set('api-version', '2018-02-01');
      url.searchParams.set('resource', checked.audience);
      headers = { Metadata: 'true' };
    }
    // client_id only: Microsoft refuses a mix with principal_id, object_id or
    // mi_res_id, and with none the endpoint uses the system-assigned identity.
    // A selector already on IDENTITY_ENDPOINT is dropped first, so no clientId
    // means no selector at all and an explicit one is the only one sent.
    const selectors: string[] = [];
    url.searchParams.forEach((_value, name) => {
      if (IDENTITY_SELECTORS.has(name.toLowerCase())) selectors.push(name);
    });
    for (const name of selectors) url.searchParams.delete(name);
    if (checked.clientId) url.searchParams.set('client_id', checked.clientId);

    let res: Response;
    try {
      res = await (seams.fetch ?? fetch)(url, {
        method: 'GET',
        headers,
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw unavailable(null, true);
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      const status = res.status;
      throw unavailable(status, status === 404 || status === 410 || status === 429 || status >= 500);
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      // The status line came, the body did not: the timeout or a dropped connection.
      throw unavailable(200, true);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw unavailable(200, false);
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) throw unavailable(200, false);
    const fields = body as { access_token?: unknown; expires_on?: unknown; expires_in?: unknown };
    const token = fields.access_token;
    if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES || !JWT_SHAPE.test(token)) {
      throw unavailable(200, false);
    }

    // expires_on is epoch seconds and equals the token's exp (a string on
    // 2019-08-01); else expires_in, seconds from now (IMDS); else use once.
    const at = now();
    const expiresOn = epochSeconds(fields.expires_on);
    const expiresIn = expiresOn === null ? epochSeconds(fields.expires_in) : null;
    const expiresAt = expiresOn !== null ? expiresOn * 1000 : expiresIn !== null ? at + expiresIn * 1000 : null;
    if (expiresAt !== null && expiresAt <= at) throw unavailable(200, false);
    if (expiresAt !== null && expiresAt - REFRESH_MARGIN_MS > at) {
      cached = { token, refreshAt: expiresAt - REFRESH_MARGIN_MS };
    }
    return token;
  }

  return (timeoutMs) => {
    if (cached && now() < cached.refreshAt) return Promise.resolve(cached.token);
    // One fetch at a time: every caller for this pair waits on the same one.
    if (inflight) return inflight;
    const run = request(timeoutMs);
    inflight = run;
    // A failure is never cached: the next call fetches again. No retry here.
    const settle = () => {
      if (inflight === run) inflight = undefined;
    };
    run.then(settle, settle);
    return run;
  };
}

/**
 * The bearer for Auth's session routes from this host's managed identity, with
 * its own private cache, plus test seams. The audience, client id and timeout
 * are checked here, so a bad setting throws `AUTH_CALLER_NOT_CONFIGURED` at
 * startup; the environment is read on each fetch.
 *
 * - App Service, Functions, Container Apps (`IDENTITY_ENDPOINT` and
 *   `IDENTITY_HEADER` both set): `GET $IDENTITY_ENDPOINT` with
 *   `resource=<audience>`, `api-version=2019-08-01` and `X-IDENTITY-HEADER`.
 * - Only one of the two set: `AUTH_CALLER_NO_IDENTITY`, and no request.
 * - Neither (VMs, scale sets, AKS): IMDS, `api-version=2018-02-01`, `Metadata: true`.
 *
 * `client_id` is sent for a user-assigned identity. A token is reused until five
 * minutes before it expires, one request runs at a time, a failure is never
 * cached and nothing is retried.
 */
export function createAuthCallerTokenSource(options: AuthCallerTokenSourceOptions): () => Promise<string> {
  const checked = checkCallerOptions(options);
  const fetchToken = tokenFetcher(checked, options);
  return () => fetchToken(checked.timeoutMs);
}

/** Shared by getAuthCallerToken: one entry per (audience, client id or "system"), in memory only. */
const sharedFetchers = new Map<string, TokenFetcher>();

/**
 * The bearer string for Auth's session routes (see
 * createAuthCallerTokenSource). Cached per process, one fetch at a time per
 * audience and identity. Rejects with `AuthCallerTokenError`.
 */
export async function getAuthCallerToken(options: AuthCallerTokenOptions): Promise<string> {
  const checked = checkCallerOptions(options);
  const key = `${checked.audience}|${checked.clientId ?? 'system'}`;
  let fetchToken = sharedFetchers.get(key);
  if (!fetchToken) {
    fetchToken = tokenFetcher(checked, {});
    sharedFetchers.set(key, fetchToken);
  }
  return fetchToken(checked.timeoutMs);
}
