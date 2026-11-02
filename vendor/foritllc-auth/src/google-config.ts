// ============================================================================
// @foritllc/auth - Google sign-in adapter: configuration (0.13.0)
//
// Every value that decides trust comes from server configuration checked when
// the handlers are built, the way `loginPrompt` is (consumer contract §4): the
// Auth origin, the workspace host and its workspaceId, this app's AppId, its
// exact callback and audience, and this app's `fau_` key. None comes from a
// request, a header, the browser or forit-Auth's answer.
//
// Off by default. Unless `enabled` is exactly `true` and a service key is set,
// the adapter is dormant (shared-service-auth.md, consumer dormancy): it
// calls nobody, the three mounted routes answer 503 GOOGLE_SIGNIN_UNCONFIGURED,
// and `requireGoogleSession` answers 401 to an API request and a path-only
// redirect to a page (see google.ts, createGoogleSignIn).
// ============================================================================

import type { GooglePrincipal } from './principal.js';
import { FORIT_TENANT_ID } from './identity.js';
import { safeReturnTo } from './return-to.js';

/** The one origin forit-Auth serves redeem, verify and revoke from (PR99 §4). */
export const AUTH_ORIGIN = 'https://auth.forit.io';

/** The one Google issuer forit-Auth accepts; the bare form is refused (PR99 §1). */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** PR99 §2 AppId shape. */
const APP_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** PR99 §4.1 workspace host shape: lower-case letters, digits, dots, hyphens; no port. */
const HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Same rule as session-crypto.ts: an unresolved Key Vault / App Configuration reference. */
const UNRESOLVED_REFERENCE = /^\s*@Microsoft\.[A-Za-z]+\s*\(/i;
/**
 * A minimum-strength shape for forit-Auth's app keys, never an authorization
 * check. Auth mints `fau_<slug>_<43 base64url characters>` (for example
 * `fau_p9-crewrecords_…`). The slug may hold `-` and the random tail may hold
 * `-` and `_`, so the two cannot be told apart safely: the rule is `fau_` then
 * at least 43 base64url characters. The slug is never read or matched to the
 * appId; authority is the whole key, its ServiceKeyId and its app scope at Auth.
 */
const SERVICE_KEY = /^fau_[A-Za-z0-9_-]{43,}$/;
/** The Google adapter's floor for SESSION_SECRET (not package-wide). */
export const MIN_GOOGLE_SESSION_SECRET_LENGTH = 32;

const DEFAULT_SESSION_MAX_AGE = 28800;
const DEFAULT_RPC_TIMEOUT_MS = 5000;

/** Thrown by `requireGoogleSignInConfigured()`; map it to 503 GOOGLE_SIGNIN_UNCONFIGURED. */
export class GoogleSignInNotConfiguredError extends Error {
  readonly code = 'GOOGLE_SIGNIN_UNCONFIGURED';
  constructor() {
    super('[forit/auth/google] Google sign-in is not configured');
    this.name = 'GoogleSignInNotConfiguredError';
  }
}

/**
 * What for-Directory answers for one object id in one tenant (R-D2, the shape
 * Directory proposed in Directory-msg). `null` for an unknown type or status.
 */
export interface DirectoryObjectStatus {
  tenantId: string;
  objectId: string;
  enabled: boolean | null;
  /** `userType` Guest, or a UPN containing `#EXT#@` (case-insensitive). */
  guest: boolean | null;
}

/** One customer tenant this app serves on this host, with its own scoped readers. */
export interface LinkedDirectoryTenant {
  /** The customer's Entra tenant id. Held in lower case and compared exactly. */
  tenantId: string;
  /**
   * Must be `true`: the readers below use this tenant's own per-tenant `fdk_`
   * key, never a shared key that spans tenants (access-groups.md, Membership).
   */
  tenantScoped: boolean;
  /**
   * R-D2: type and enabled status of exactly this object id in exactly this
   * tenant, by Entra object id, with no alias, email or local-id fallback.
   * Required: without it linked group access cannot be configured at all.
   * Return null (or throw) when the answer is unknown or unavailable.
   */
  readObjectStatus: (target: { tenantId: string; objectId: string }) => Promise<DirectoryObjectStatus | null>;
  /**
   * The group object ids of exactly this object id in this tenant, by object
   * id only. Must be R-D1's complete transitive route once for-Directory serves
   * it; the direct `getDirectGroupIds` list is not a stand-in (consumer
   * contract §3, step 4). Return null (or throw) on any doubt.
   */
  readGroupIds: (target: { tenantId: string; objectId: string }) => Promise<readonly string[] | null>;
}

/**
 * Group access for a linked Google principal. Absent = denied: every gated
 * surface is hidden for every Google principal (consumer contract §3).
 */
export interface LinkedDirectoryConfig {
  tenants: readonly LinkedDirectoryTenant[];
  /**
   * The app's Entra guest policy, applied to the linked object with no
   * exception for the link (§3 rule 5). Default `true`, and it should match
   * the app's own `rejectGuests`. Never turn it off just to make Google work.
   */
  rejectGuests?: boolean;
}

/**
 * The opt-in sign-in hook. It gets the principal and the request, never a token.
 * It admits only by returning nothing or `{ allowed: true }`. Every other
 * answer refuses and revokes the new session: `{ allowed: false }` (with an
 * optional `error` code, `^[a-z][a-z0-9_]{0,63}$`, sent as `?error=`), and in
 * plain JS also `true`, `false`, null, 0, '', a string, `{ error }` with no
 * `allowed`, or an `allowed` that is not exactly `true` (all `google_denied`).
 * A throw is `google_failed`.
 */
export type GoogleSignedInHook = (
  principal: GooglePrincipal,
  request: Request,
) => Promise<void | { allowed: true } | { allowed: false; error?: string }>;

export interface GoogleSignInConfig {
  /** Must be exactly `true`. Anything else leaves the adapter dormant and unchecked. */
  enabled?: boolean;
  /**
   * This app's `fau_` key to forit-Auth, scoped exactly `apps:<appId>:session`
   * and bound as the app's ServiceKeyId (PR99 §4). Blank = dormant. Not a
   * Google credential: the app never holds one. A live adapter refuses at
   * startup an unresolved Key Vault reference and anything that is not `fau_`
   * plus at least 43 base64url characters.
   */
  serviceKey?: string;
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
  /** Where the app mounts `routes.login`, for `signInHref()`. Default `/api/auth/google/login`. */
  loginPath?: string;
  /** Where the callback sends a browser with no `returnTo`. Default `/`. */
  defaultReturnTo?: string;
  /** Path that receives `?error=google_*` redirects. Default `/`. */
  errorPath?: string;
  /** Where a page with no Google session is sent, with `?returnTo=`. Default `/`. */
  signInPath?: string;
  /** Where logout sends the browser. Default `/`. */
  signedOutPath?: string;
  /** Cookie lifetime cap in seconds, 300 to 28800. Default 28800. Auth's expiresAt caps it too. */
  sessionMaxAge?: number;
  /** Per-call timeout to forit-Auth, 100 to 30000 ms. Default 5000. */
  rpcTimeoutMs?: number;
  onSignedIn?: GoogleSignedInHook;
  linkedDirectory?: LinkedDirectoryConfig;
  /** Refused: the Google session cookie is host-only (`__Host-`). */
  cookieDomain?: never;
}

/** A checked configuration. Dormant ones carry nothing else. */
export type ResolvedGoogleConfig =
  | { live: false }
  | {
      live: true;
      serviceKey: string;
      appId: string;
      workspaceHost: string;
      workspaceId: string;
      audience: string;
      callback: string;
      loginPath: string;
      defaultReturnTo: string;
      errorPath: string;
      signInPath: string;
      signedOutPath: string;
      sessionMaxAge: number;
      rpcTimeoutMs: number;
      onSignedIn?: GoogleSignedInHook;
      linked: ResolvedLinkedDirectory | null;
    };

export interface ResolvedLinkedDirectory {
  /** Keyed on the lower-case tenant id. */
  tenants: ReadonlyMap<string, LinkedDirectoryTenant>;
  rejectGuests: boolean;
}

function refuse(problem: string): never {
  throw new Error(`[forit/auth/google] ${problem}`);
}

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

function checkPath(raw: unknown, name: string, fallback = '/'): string {
  if (raw === undefined) return fallback;
  const path = safeReturnTo(raw, '');
  if (!path) refuse(`${name} must be a same-origin path.`);
  return path;
}

function checkInt(raw: unknown, name: string, min: number, max: number, fallback: number): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
    refuse(`${name} must be an integer from ${min} to ${max}.`);
  }
  return raw;
}

function checkLinked(raw: LinkedDirectoryConfig | undefined): ResolvedLinkedDirectory | null {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tenants) || raw.tenants.length === 0) {
    refuse('linkedDirectory needs at least one tenant; leave it unset to deny every linked principal.');
  }
  if (raw.rejectGuests !== undefined && typeof raw.rejectGuests !== 'boolean') {
    refuse('linkedDirectory.rejectGuests must be a boolean.');
  }
  const tenants = new Map<string, LinkedDirectoryTenant>();
  for (const tenant of raw.tenants) {
    const id = typeof tenant?.tenantId === 'string' ? tenant.tenantId.toLowerCase() : '';
    if (!UUID.test(id)) refuse('linkedDirectory tenantId must be an Entra tenant id (a GUID).');
    if (id === FORIT_TENANT_ID) {
      refuse('linkedDirectory cannot serve the ForIT tenant: a Google principal is never ForIT staff.');
    }
    if (tenants.has(id)) refuse('linkedDirectory lists a tenant twice.');
    if (tenant.tenantScoped !== true) {
      refuse('linkedDirectory tenants must use a tenant-scoped Directory key (tenantScoped: true).');
    }
    if (typeof tenant.readObjectStatus !== 'function') {
      refuse('linkedDirectory needs readObjectStatus (R-D2) for every tenant: without it linked group access stays denied.');
    }
    if (typeof tenant.readGroupIds !== 'function') {
      refuse('linkedDirectory needs readGroupIds for every tenant.');
    }
    tenants.set(id, tenant);
  }
  return { tenants, rejectGuests: raw.rejectGuests ?? true };
}

/**
 * Check a configuration once, when the handlers are built. Throws on any value
 * that could make the adapter trust the wrong thing. Returns dormant for
 * `enabled !== true` (nothing else is read) and for a blank service key.
 */
export function resolveGoogleConfig(config: GoogleSignInConfig): ResolvedGoogleConfig {
  if (!config || config.enabled !== true) return { live: false };

  const authOrigin = config.authOrigin ?? AUTH_ORIGIN;
  if (authOrigin !== AUTH_ORIGIN) {
    refuse(`authOrigin must be ${AUTH_ORIGIN}: forit-Auth serves the session calls from that origin only.`);
  }
  if ('cookieDomain' in config && config.cookieDomain !== undefined) {
    refuse('cookieDomain is refused: the Google session cookie is host-only.');
  }
  if (typeof config.appId !== 'string' || !APP_ID.test(config.appId)) {
    refuse('appId must match ^[a-z0-9][a-z0-9-]{2,63}$.');
  }
  if (typeof config.workspaceHost !== 'string' || config.workspaceHost.length > 253 || !HOST.test(config.workspaceHost)) {
    refuse('workspaceHost must be a lower-case host name with no port.');
  }
  const workspaceId = typeof config.workspaceId === 'string' ? config.workspaceId.toLowerCase() : '';
  if (!UUID.test(workspaceId)) refuse('workspaceId must be the workspace GUID.');
  const audience = checkAudience(config.audience);
  const callback = checkCallback(config.callback, audience);
  if (config.onSignedIn !== undefined && typeof config.onSignedIn !== 'function') {
    refuse('onSignedIn must be a function.');
  }

  const resolved = {
    appId: config.appId,
    workspaceHost: config.workspaceHost,
    workspaceId,
    audience,
    callback,
    loginPath: checkPath(config.loginPath, 'loginPath', '/api/auth/google/login'),
    defaultReturnTo: checkPath(config.defaultReturnTo, 'defaultReturnTo'),
    errorPath: checkPath(config.errorPath, 'errorPath'),
    signInPath: checkPath(config.signInPath, 'signInPath'),
    signedOutPath: checkPath(config.signedOutPath, 'signedOutPath'),
    sessionMaxAge: checkInt(config.sessionMaxAge, 'sessionMaxAge', 300, 28800, DEFAULT_SESSION_MAX_AGE),
    rpcTimeoutMs: checkInt(config.rpcTimeoutMs, 'rpcTimeoutMs', 100, 30000, DEFAULT_RPC_TIMEOUT_MS),
    onSignedIn: config.onSignedIn,
    linked: checkLinked(config.linkedDirectory),
  };

  const key = config.serviceKey;
  if (key === undefined || key === null || (typeof key === 'string' && !key.trim())) {
    return { live: false };
  }
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

  return { live: true, serviceKey: key, ...resolved };
}

/**
 * The Google adapter's own SESSION_SECRET floor: at least 32 characters, not
 * counting surrounding whitespace. Call it after `assertSessionSecret()`, which
 * refuses a missing value and an unresolved reference first. Skipped during
 * `next build` (NEXT_PHASE=phase-production-build), as that check is. The
 * Entra routes keep the package-wide rule; this floor is not applied to them.
 */
export function assertGoogleSessionSecret(): void {
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  const secret = process.env.SESSION_SECRET ?? '';
  if (secret.trim().length < MIN_GOOGLE_SESSION_SECRET_LENGTH) {
    refuse(
      `SESSION_SECRET must be at least ${MIN_GOOGLE_SESSION_SECRET_LENGTH} characters for Google sign-in: a short ` +
        'secret makes the session and transaction cookies guessable. ' +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
}
