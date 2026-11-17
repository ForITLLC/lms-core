// ============================================================================
// @foritllc/auth - Microsoft sign-in through forit-Auth: configuration and principal
//
// The configuration half of `@foritllc/auth/microsoft` (microsoft.ts). Every
// value that decides trust comes from server configuration checked when the
// handlers are built, as the Google adapter's does (google-config.ts): the
// Auth origin, the workspace host and its workspaceId, this app's AppId, its
// exact callback and audience, how this app proves itself to forit-Auth, and,
// for Microsoft, the ONE Entra tenant, its exact issuer and the app's own
// admission policy. None comes from a request, a header, the browser or
// forit-Auth's answer.
//
// Three settings are never optional and never defaulted. Whenever `enabled`
// is exactly `true`, each is checked in full, before anything else and before
// the caller proof is looked at, and a bad one throws:
//
//   tenantId  the Entra tenant, a canonical lower-case GUID. Upper case is a
//             configuration error; it is not folded.
//   issuer    the exact issuer forit-Auth reports for that tenant, in one of
//             the three tenant-specific forms listed at ISSUER_FORMS.
//   policy    who may sign in. There is no allow-all and no default: a signed-in
//             Microsoft person is NOT admitted because they are in the tenant.
//
// Otherwise the rules are the Google adapter's. Unless `enabled` is exactly
// `true` and a service key or `caller: 'managed-identity'` is set, the adapter
// is dormant: it reads nothing else, calls nobody, admits nobody, and its
// routes answer 503 MICROSOFT_SIGNIN_UNCONFIGURED. A switched-off adapter
// never stops the app from starting.
//
// The backend caller proof (the `fau_` key or the app's managed identity
// token) only authenticates this app's server to forit-Auth. Nothing from it
// is ever placed on a MicrosoftPrincipal.
//
// The small private checks below (audience, callback, path, integer, the key
// and host shapes) mirror google-config.ts, which does not export them.
// ============================================================================

import { authCallerAudienceOf, createAuthCallerTokenSource, identityClientIdOf } from './client-assertion.js';
import { APP_ID, AUTH_ORIGIN } from './google-config.js';
import type { EntraPrincipal, GooglePrincipal } from './principal.js';
import { safeReturnTo } from './return-to.js';
import type { BaseSession } from './types.js';

/** A canonical lower-case GUID. No `i` flag: upper case never matches. */
export const CANONICAL_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Mirrors google-config.ts HOST: lower-case letters, digits, dots, hyphens; no port. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
/** Mirrors google-config.ts and session-crypto.ts: an unresolved Key Vault / App Configuration reference. */
const UNRESOLVED_REFERENCE = /^\s*@Microsoft\.[A-Za-z]+\s*\(/i;
/** Mirrors google-config.ts SERVICE_KEY: a minimum-strength shape for forit-Auth's app keys, never an authorization check. */
const SERVICE_KEY = /^fau_[A-Za-z0-9_-]{43,}$/;
/** The Microsoft adapter's floor for SESSION_SECRET (the Google adapter's floor is the same number). */
export const MIN_MICROSOFT_SESSION_SECRET_LENGTH = 32;

const DEFAULT_SESSION_MAX_AGE = 28800;
const DEFAULT_RPC_TIMEOUT_MS = 5000;
const DEFAULT_LOGIN_PATH = '/api/auth/microsoft/login';

/**
 * The tenant-specific Entra issuer forms forit-Auth classifies. Group 1 is the
 * tenant, which must equal `tenantId`. A multi-tenant issuer (`common`,
 * `organizations`, `consumers`) matches none of them.
 *
 *   https://login.microsoftonline.com/<tenant>/v2.0
 *   https://<name>.ciamlogin.com/<tenant>/v2.0     (<name> is one DNS label)
 *   https://sts.windows.net/<tenant>/
 */
const ISSUER_FORMS: readonly RegExp[] = [
  /^https:\/\/login\.microsoftonline\.com\/([^/]+)\/v2\.0$/,
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ciamlogin\.com\/([^/]+)\/v2\.0$/,
  /^https:\/\/sts\.windows\.net\/([^/]+)\/$/,
];

/** Nothing throws it: a dormant adapter's routes answer 503 with its `code`, MICROSOFT_SIGNIN_UNCONFIGURED. */
export class MicrosoftSignInNotConfiguredError extends Error {
  readonly code = 'MICROSOFT_SIGNIN_UNCONFIGURED';
  constructor() {
    super('[forit/auth/microsoft] Microsoft sign-in is not configured');
    this.name = 'MicrosoftSignInNotConfiguredError';
  }
}

/**
 * A Microsoft sign-in, built from ONE forit-Auth answer and alive for one
 * request. Never put it in a cookie, a cache or a store: the next request
 * verifies again.
 *
 * It says who signed in and nothing about what they may do. It carries no
 * guest or member flag, no staff flag, no groups and no email, because
 * forit-Auth sends none. It is not a `BaseSession`, a `GooglePrincipal` or an
 * `EntraPrincipal`: the `never` fields below and the `provider` discriminant
 * keep every helper that reads `tid`, `azureOid`, `email` or `isGuest` from
 * taking it for one (see the compile-time check under this interface).
 */
export interface MicrosoftPrincipal {
  /** The discriminant. An Entra session from the package's own routes is `entra`, never this. */
  provider: 'microsoft';
  /** Equals the configured issuer exactly. */
  issuer: string;
  /** Equals the configured tenantId: forit-Auth's `directory.tenantId`, a lower-case GUID. */
  tenantId: string;
  /** The person's Entra object id: forit-Auth's `directory.objectId`, a lower-case GUID, equal to `subject`. */
  objectId: string;
  /** forit-Auth's `subject`: the Entra `oid`, a lower-case GUID. */
  subject: string;
  /** forit-Auth's AccessPrincipals id. Not the object id and not the session handle. */
  principalId: string;
  /** Equals the configured workspaceId. */
  workspaceId: string;
  /** forit-Auth's public AppSessions id, for audit only. Not the session handle. */
  sessionId: string;
  /** A label. Escape it when shown. Never decides identity, tenancy, staff status or a role. */
  displayName: string;
  /** Ms since epoch: the earlier of forit-Auth's expiry and the expiry bound into the cookie at sign-in. */
  expiresAt: number;
  authUserId?: never;
  tid?: never;
  iss?: never;
  azureOid?: never;
  email?: never;
  emailVerified?: never;
  hostedDomain?: never;
  isGuest?: never;
  isStaff?: never;
  name?: never;
  loginHint?: never;
  groups?: never;
  directory?: never;
  target?: never;
}

// Compile-time proof that a MicrosoftPrincipal cannot be passed where the
// package's other identities are expected. If someone makes it assignable to
// one of them, the build fails here.
type NotAssignable<A, B> = [A] extends [B] ? false : true;
type Proven<T extends true> = T;
const MICROSOFT_PRINCIPAL_IS_DISTINCT: Proven<NotAssignable<MicrosoftPrincipal, BaseSession>> &
  Proven<NotAssignable<MicrosoftPrincipal, GooglePrincipal>> &
  Proven<NotAssignable<MicrosoftPrincipal, EntraPrincipal>> = true;
void MICROSOFT_PRINCIPAL_IS_DISTINCT;

/** What the policy is asked: the verified principal, and whether this is the sign-in or a later request. */
export interface MicrosoftPolicyInput {
  principal: MicrosoftPrincipal;
  phase: 'callback' | 'request';
}

/**
 * Who may sign in. REQUIRED, with no default and no allow-all. It runs at the
 * callback and again on every request's verify.
 *
 * - `allow`: the exact people. The principal's tenantId and objectId must
 *   equal one entry. Each entry is two canonical lower-case GUIDs, its
 *   tenantId must be the configured tenant, and no entry may repeat; one bad
 *   entry refuses the whole configuration.
 * - `decide`: the app's own rule. It must resolve exactly `true`. `false`, any
 *   other value and a throw admit nobody.
 * - Both present: both must pass (`allow` is checked first, and `decide` is
 *   not called for someone `allow` refused).
 * - At least one must be present. An empty `allow` with no `decide` is a
 *   configuration error. An empty `allow` WITH `decide` is accepted and admits
 *   nobody, whatever `decide` answers: the list is still required to match.
 * - Any other key on the object is a configuration error, so a misspelt
 *   `allow` cannot silently leave `decide` alone in charge.
 */
export interface MicrosoftPolicy {
  allow?: ReadonlyArray<{ tenantId: string; objectId: string }>;
  decide?: (input: MicrosoftPolicyInput) => boolean | Promise<boolean>;
}

export interface MicrosoftSignInConfig {
  /** Must be exactly `true`. Anything else leaves the adapter dormant, and nothing else is read. */
  enabled?: boolean;
  /**
   * This app's `fau_` key to forit-Auth, scoped exactly `apps:<appId>:session`
   * and bound as the app's ServiceKeyId. Blank = dormant. A live adapter
   * refuses at startup an unresolved Key Vault reference and anything that is
   * not `fau_` plus at least 43 base64url characters. Never together with `caller`.
   */
  serviceKey?: string;
  /**
   * Prove this app to forit-Auth with a token from its own managed identity,
   * in place of `serviceKey`. The only accepted value; never together with a
   * key. It authenticates the backend only and is never the person's identity.
   */
  caller?: 'managed-identity';
  /** Auth's caller app client id, a GUID, from `process.env.AUTH_MI_AUDIENCE`. Required with `caller`. */
  authCallerAudience?: string;
  /** Client id of this app's user-assigned identity, from `process.env.AUTH_MI_CLIENT_ID`. Unset for system-assigned. */
  managedIdentityClientId?: string;
  /** Default and only accepted value: `https://auth.forit.io`. */
  authOrigin?: string;
  /** The app's RelyingApps.AppId. */
  appId: string;
  /** The app's RelyingApps.WorkspaceHost, where authorize runs. */
  workspaceHost: string;
  /** The workspace behind that host, agreed with forit-Auth. Held in lower case. */
  workspaceId: string;
  /** The app's origin, `https://host` with no path, port, query or fragment. */
  audience: string;
  /** The app's exact RelyingApps.CallbackUrl, on the audience origin. */
  callback: string;
  /** REQUIRED. The one Entra tenant whose people may sign in: a canonical lower-case GUID. */
  tenantId: string;
  /** REQUIRED. The exact issuer forit-Auth reports for that tenant; one of the three tenant-specific forms. */
  issuer: string;
  /** REQUIRED. Who may sign in. See MicrosoftPolicy. */
  policy: MicrosoftPolicy;
  /**
   * Optional one-use custody for the sign-in transaction. The callback calls
   * it with the transaction's random id after the state check and before the
   * redeem, and redeems only when it resolves exactly `true`. It must return
   * `true` the first time it sees an id and never again (an atomic insert in
   * the app's own store). `false`, any other value and a throw mean no redeem.
   *
   * Without it, one-use rests on two things only: the signed, browser-bound,
   * ten-minute transaction cookie, which the callback clears on every answer,
   * and forit-Auth's one-use code. Clearing a cookie is not proof across
   * requests: a copy of the cookie taken before the callback still opens.
   */
  consumeTransaction?: (transactionId: string) => boolean | Promise<boolean>;
  /** Where the app mounts `routes.login`, for `signInHref()`. Default `/api/auth/microsoft/login`. */
  loginPath?: string;
  /** Where the callback sends a browser with no `returnTo`. Default `/`. */
  defaultReturnTo?: string;
  /** Path that receives `?error=microsoft_*` redirects. Default `/`. Keep it public. */
  errorPath?: string;
  /** Where a page with no Microsoft session is sent, with `?returnTo=`. Default `/`. */
  signInPath?: string;
  /** Where logout sends the browser. Default `/`. */
  signedOutPath?: string;
  /** Session lifetime cap in seconds, 300 to 28800. Default 28800. Auth's expiresAt caps it too. */
  sessionMaxAge?: number;
  /** Per-call timeout to forit-Auth, 100 to 30000 ms. Default 5000. */
  rpcTimeoutMs?: number;
  /** Refused: the Microsoft session cookie is host-only (`__Host-`). */
  cookieDomain?: never;
}

/** How a live adapter proves itself to forit-Auth. Same two kinds as the Google adapter's. */
export type MicrosoftCallerProof =
  | { kind: 'key'; serviceKey: string }
  | { kind: 'identity'; audience: string; clientId: string | null; token: () => Promise<string> };

/** A checked policy. `allow` holds `<tenantId>/<objectId>` keys. */
export interface ResolvedMicrosoftPolicy {
  allow: ReadonlySet<string> | null;
  decide: ((input: MicrosoftPolicyInput) => boolean | Promise<boolean>) | null;
}

/** A checked configuration. Dormant ones carry nothing else. */
export type ResolvedMicrosoftConfig =
  | { live: false }
  | {
      live: true;
      proof: MicrosoftCallerProof;
      appId: string;
      workspaceHost: string;
      workspaceId: string;
      audience: string;
      callback: string;
      tenantId: string;
      issuer: string;
      policy: ResolvedMicrosoftPolicy;
      consumeTransaction: ((transactionId: string) => boolean | Promise<boolean>) | null;
      loginPath: string;
      defaultReturnTo: string;
      errorPath: string;
      signInPath: string;
      signedOutPath: string;
      sessionMaxAge: number;
      rpcTimeoutMs: number;
    };

function refuse(problem: string): never {
  throw new Error(`[forit/auth/microsoft] ${problem}`);
}

/** The key an allow-list entry and a principal are compared on. */
export function allowKey(tenantId: string, objectId: string): string {
  return `${tenantId}/${objectId}`;
}

function checkTenantId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) {
    refuse('tenantId is required: the one Entra tenant whose people may sign in. There is no default.');
  }
  if (!CANONICAL_GUID.test(raw)) {
    refuse('tenantId must be a canonical lower-case GUID. Upper case is refused, never folded.');
  }
  return raw;
}

function checkIssuer(raw: unknown, tenantId: string): string {
  if (typeof raw !== 'string' || !raw) {
    refuse('issuer is required: the exact issuer forit-Auth reports for the tenant. There is no default.');
  }
  let tenant: string | null = null;
  for (const form of ISSUER_FORMS) {
    const match = form.exec(raw);
    if (match) {
      tenant = match[1];
      break;
    }
  }
  if (tenant === null) {
    refuse(
      'issuer must be one of the tenant-specific Entra forms: https://login.microsoftonline.com/<tenant>/v2.0, ' +
        'https://<name>.ciamlogin.com/<tenant>/v2.0 or https://sts.windows.net/<tenant>/.',
    );
  }
  if (tenant !== tenantId) {
    refuse('issuer must name the configured tenantId exactly (a lower-case GUID); it names another tenant or none.');
  }
  return raw;
}

function checkPolicy(raw: unknown, tenantId: string): ResolvedMicrosoftPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    refuse('policy is required: { allow } and/or { decide }. There is no default and no allow-all.');
  }
  const policy = raw as Record<string, unknown>;
  for (const key of Object.keys(policy)) {
    if (key !== 'allow' && key !== 'decide') refuse('policy accepts only allow and decide.');
  }
  const hasAllow = policy.allow !== undefined;
  const hasDecide = policy.decide !== undefined;
  if (!hasAllow && !hasDecide) {
    refuse('policy is empty: set allow, decide or both. There is no default and no allow-all.');
  }
  if (hasDecide && typeof policy.decide !== 'function') refuse('policy.decide must be a function.');

  let allow: Set<string> | null = null;
  if (hasAllow) {
    if (!Array.isArray(policy.allow)) refuse('policy.allow must be a list of { tenantId, objectId }.');
    const entries: unknown[] = policy.allow;
    if (entries.length === 0 && !hasDecide) {
      refuse('policy.allow is empty and there is no decide: nobody could sign in. Name the people or add decide.');
    }
    allow = new Set<string>();
    for (const entry of entries) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        refuse('policy.allow entries must be { tenantId, objectId }.');
      }
      const { tenantId: entryTenant, objectId: entryObject } = entry as Record<string, unknown>;
      if (typeof entryTenant !== 'string' || !CANONICAL_GUID.test(entryTenant)) {
        refuse('policy.allow tenantId must be a canonical lower-case GUID.');
      }
      if (typeof entryObject !== 'string' || !CANONICAL_GUID.test(entryObject)) {
        refuse('policy.allow objectId must be a canonical lower-case GUID.');
      }
      if (entryTenant !== tenantId) refuse('policy.allow tenantId must equal the configured tenantId.');
      const key = allowKey(entryTenant, entryObject);
      if (allow.has(key)) refuse('policy.allow lists one person twice.');
      allow.add(key);
    }
  }
  return {
    allow,
    decide: hasDecide ? (policy.decide as (input: MicrosoftPolicyInput) => boolean | Promise<boolean>) : null,
  };
}

// Mirrors google-config.ts checkAudience.
function checkAudience(raw: unknown): string {
  if (typeof raw !== 'string') refuse('audience is required: the app origin, https://host.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('audience is not a URL.');
  }
  if (
    url.protocol !== 'https:' ||
    url.username || url.password || url.port ||
    url.pathname !== '/' || url.search || url.hash ||
    url.origin !== raw ||
    !HOST.test(url.hostname) || url.hostname.length > 253
  ) {
    refuse('audience must be exactly an https origin (https://host), with no path, port, user info, query or fragment.');
  }
  return raw;
}

// Mirrors google-config.ts checkCallback.
function checkCallback(raw: unknown, audience: string): string {
  if (typeof raw !== 'string' || raw.length > 512) refuse('callback is required, at most 512 characters.');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    refuse('callback is not a URL.');
  }
  if (url.origin !== audience || url.username || url.password || url.search || url.hash || url.href !== raw) {
    refuse('callback must be an exact https URL on the audience origin, with no query or fragment.');
  }
  return raw;
}

// Mirrors google-config.ts checkPath.
function checkPath(raw: unknown, name: string, fallback = '/'): string {
  if (raw === undefined) return fallback;
  const path = safeReturnTo(raw, '');
  if (!path) refuse(`${name} must be a same-origin path.`);
  return path;
}

// Mirrors google-config.ts checkInt.
function checkInt(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    refuse(`${name} must be an integer from ${min} to ${max}.`);
  }
  return raw;
}

/** Unset, null or only spaces. Mirrors google-config.ts blank. */
function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * Check a configuration once, when the handlers are built.
 *
 * - No configuration at all (undefined, null), or `enabled !== true`, is
 *   dormant and nothing else is read, as `resolveGoogleConfig` does.
 * - With `enabled: true`, `tenantId`, `issuer` and `policy` are checked in
 *   full FIRST: a missing, empty or malformed one throws, with or without a
 *   caller proof. There is no default and no allow-all.
 * - Then, as `resolveGoogleConfig`: every other trust value throws when
 *   wrong; both proofs or a half-set identity caller throw; neither proof is
 *   dormant.
 */
export function resolveMicrosoftConfig(config: MicrosoftSignInConfig): ResolvedMicrosoftConfig {
  if (!config || config.enabled !== true) return { live: false };

  const tenantId = checkTenantId(config.tenantId);
  const issuer = checkIssuer(config.issuer, tenantId);
  const policy = checkPolicy(config.policy, tenantId);

  const authOrigin = config.authOrigin ?? AUTH_ORIGIN;
  if (authOrigin !== AUTH_ORIGIN) {
    refuse(`authOrigin must be ${AUTH_ORIGIN}: forit-Auth serves the session calls from that origin only.`);
  }
  if ('cookieDomain' in config && config.cookieDomain !== undefined) {
    refuse('cookieDomain is refused: the Microsoft session cookie is host-only.');
  }
  if (typeof config.appId !== 'string' || !APP_ID.test(config.appId)) {
    refuse('appId must match ^[a-z0-9][a-z0-9-]{2,63}$.');
  }
  if (typeof config.workspaceHost !== 'string' || config.workspaceHost.length > 253 || !HOST.test(config.workspaceHost)) {
    refuse('workspaceHost must be a lower-case host name with no port.');
  }
  const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId.toLowerCase() : '';
  if (!CANONICAL_GUID.test(workspaceId)) refuse('workspaceId must be the workspace GUID.');
  const audience = checkAudience(config.audience);
  const callback = checkCallback(config.callback, audience);
  if (config.consumeTransaction !== undefined && typeof config.consumeTransaction !== 'function') {
    refuse('consumeTransaction must be a function.');
  }

  const resolved = {
    appId: config.appId,
    workspaceHost: config.workspaceHost,
    workspaceId,
    audience,
    callback,
    tenantId,
    issuer,
    policy,
    consumeTransaction: config.consumeTransaction ?? null,
    loginPath: checkPath(config.loginPath, 'loginPath', DEFAULT_LOGIN_PATH),
    defaultReturnTo: checkPath(config.defaultReturnTo, 'defaultReturnTo'),
    errorPath: checkPath(config.errorPath, 'errorPath'),
    signInPath: checkPath(config.signInPath, 'signInPath'),
    signedOutPath: checkPath(config.signedOutPath, 'signedOutPath'),
    sessionMaxAge: checkInt(config.sessionMaxAge, 'sessionMaxAge', 300, 28800, DEFAULT_SESSION_MAX_AGE),
    rpcTimeoutMs: checkInt(config.rpcTimeoutMs, 'rpcTimeoutMs', 100, 30000, DEFAULT_RPC_TIMEOUT_MS),
  };

  // The proof: exactly one of a key and a managed identity (Auth's row names one).
  const key = config.serviceKey;
  const hasKey = !blank(key);
  const caller: unknown = config.caller;
  const hasCaller = caller !== undefined && caller !== null;
  const hasIdentitySetting = !blank(config.authCallerAudience) || !blank(config.managedIdentityClientId);
  if (hasKey && (hasCaller || hasIdentitySetting)) {
    refuse(
      'both proofs: serviceKey and a managed identity caller (caller, authCallerAudience or managedIdentityClientId) ' +
        "are both set. forit-Auth's app row names exactly one; keep the one it names.",
    );
  }
  if (hasCaller && caller !== 'managed-identity') {
    refuse("caller must be 'managed-identity', or unset to use serviceKey.");
  }
  if (!hasCaller && hasIdentitySetting) {
    refuse("authCallerAudience and managedIdentityClientId are used only with caller: 'managed-identity'.");
  }

  if (hasCaller) {
    // Identity mode: build the token source now, so a bad setting is refused
    // at startup, and fetch nothing until the first call to Auth.
    const callerAudience = authCallerAudienceOf(config.authCallerAudience);
    if (callerAudience === null) {
      refuse(
        "authCallerAudience (AUTH_MI_AUDIENCE) must be forit-Auth's caller app client id: a GUID with no spaces, " +
          'never an api:// name or Microsoft Graph.',
      );
    }
    const clientId = identityClientIdOf(config.managedIdentityClientId);
    if (clientId === undefined) {
      refuse(
        "managedIdentityClientId (AUTH_MI_CLIENT_ID) must be the client id (a GUID) of this app's user-assigned " +
          'identity; leave it unset for the system-assigned identity.',
      );
    }
    const token = createAuthCallerTokenSource({
      audience: callerAudience,
      ...(clientId ? { clientId } : {}),
      timeoutMs: resolved.rpcTimeoutMs,
    });
    return { live: true, proof: { kind: 'identity', audience: callerAudience, clientId, token }, ...resolved };
  }

  if (!hasKey) return { live: false };
  if (typeof key !== 'string') refuse('serviceKey must be a string.');
  if (UNRESOLVED_REFERENCE.test(key)) {
    refuse(
      'serviceKey is an unresolved reference (it starts with "@Microsoft."), not a key: the platform could not read ' +
        'the Key Vault secret. Fix the managed identity access or the reference, then restart.',
    );
  }
  if (!SERVICE_KEY.test(key)) {
    refuse("serviceKey must be this app's fau_ key to forit-Auth: fau_ then at least 43 base64url characters.");
  }

  return { live: true, proof: { kind: 'key', serviceKey: key }, ...resolved };
}

/**
 * The Microsoft adapter's own SESSION_SECRET floor: at least 32 characters,
 * not counting surrounding whitespace. Call it after `assertSessionSecret()`,
 * which refuses a missing value and an unresolved reference first. Skipped
 * during `next build` (NEXT_PHASE=phase-production-build), as that check is.
 */
export function assertMicrosoftSessionSecret(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.trim().length < MIN_MICROSOFT_SESSION_SECRET_LENGTH) {
    refuse(
      `SESSION_SECRET must be at least ${MIN_MICROSOFT_SESSION_SECRET_LENGTH} characters for Microsoft sign-in: a short ` +
        'secret makes the session and transaction cookies guessable. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
}
