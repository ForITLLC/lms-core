// ============================================================================
// @foritllc/auth - Google sign-in adapter: configuration (0.13.0, 0.18.0)
//
// Every value that decides trust comes from server configuration checked when
// the handlers are built, the way `loginPrompt` is (consumer contract §4): the
// Auth origin, the workspace host and its workspaceId, this app's AppId, its
// exact callback and audience, and how this app proves itself to forit-Auth.
// None comes from a request, a header, the browser or forit-Auth's answer.
//
// The proof is exactly one of two (Auth's app row names one, never both):
// this app's `fau_` key (`serviceKey`), or from 0.18.0 a token from this app's
// own managed identity (`caller: 'managed-identity'`, with Auth's caller
// audience from AUTH_MI_AUDIENCE and, for a user-assigned identity, its client
// id from AUTH_MI_CLIENT_ID). Identity mode builds its token source at startup
// and fetches nothing until the first call to Auth.
//
// Off by default. Unless `enabled` is exactly `true` and a service key or
// `caller: 'managed-identity'` is set, the adapter is dormant
// (shared-service-auth.md, consumer dormancy): it calls nobody, its mounted
// routes answer 503 GOOGLE_SIGNIN_UNCONFIGURED, and `requireGoogleSession`
// answers 401 to an API request and a path-only redirect to a page (see
// google.ts, createGoogleSignIn).
//
// Linked group access (0.24.0, C4): `linkedDirectory` is keyed by the link's
// labelled target. `tenants` serves Entra-object links by tenant id; from
// 0.24.0 `partitions` serves Directory-person links by partition id, each with
// that partition's own scoped Directory key. One customer has one group master
// (C5), so one id cannot be both a tenant and a partition.
// ============================================================================

import type { GooglePrincipal } from './principal.js';
import { FORIT_TENANT_ID } from './identity.js';
import { safeReturnTo } from './return-to.js';
import { authCallerAudienceOf, createAuthCallerTokenSource, identityClientIdOf } from './client-assertion.js';

/** The one origin forit-Auth serves redeem, verify and revoke from (PR99 §4). */
export const AUTH_ORIGIN = 'https://auth.forit.io';

/** The one Google issuer forit-Auth accepts; the bare form is refused (PR99 §1). */
export const GOOGLE_ISSUER = 'https://accounts.google.com';

/** PR99 §2 AppId shape. Exported so a closed adapter can still name its cookie (google.ts). */
export const APP_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
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

/** Nothing throws it: a dormant adapter's routes answer 503 with its `code`, GOOGLE_SIGNIN_UNCONFIGURED. */
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
 * 0.24.0. What for-Directory answers for one person in one partition, in ONE
 * call so there is no gap between the status and the groups (C3; ADR 0022
 * amendment 2026-11-07): `{ partitionId, personId, enabled, groups, asOf }`,
 * the shape Directory accepted (Tasks 3CA5AD85, comment A07460F3). Directory
 * answers 404 for an unknown, disabled or out-of-partition person, never
 * `200 []`: the reader returns null (or throws) for that, and for any doubt.
 */
export interface DirectoryPersonAccess {
  /** Must echo the requested partition id. */
  partitionId: string;
  /** Must echo the requested person id. */
  personId: string;
  /** Must be exactly `true`. */
  enabled: boolean | null;
  /**
   * Directory's permanent group ids (GUIDs) of the Directory-mastered
   * `App_<Product>` / `App_<Product>_<Role>` groups the person is in. Read
   * only after `enabled === true` for this exact person; never a bare list.
   */
  groups: readonly string[];
  /**
   * When Directory read this answer (for-Directory sends it; 3CA5AD85 comment
   * A07460F3). Accepted and ignored: it never grants or denies, is not
   * checked, and is not passed on. Freshness comes from reading on every
   * request (R-C1), never from this value.
   */
  asOf?: string;
}

/**
 * 0.24.0. One for-Directory partition for a customer with no Entra members
 * that this app serves on this host, with its own scoped reader.
 * DENIED BY DEFAULT: leave it out until for-Directory ships the person-id
 * status and group route (A1).
 */
export interface LinkedDirectoryPartition {
  /**
   * Directory's partition id (a GUID): the app's partition form. Held in lower
   * case and compared exactly: a verify `target` whose `partitionId` is not
   * one of these gets no groups and no Directory read. Auth binds the same
   * partition on its relying-app row (A969B4BE, answer Q7); this is the app's
   * own copy, from server configuration, never from the request.
   */
  partitionId: string;
  /**
   * Must be `true`: the reader uses this partition's own scoped Directory key,
   * never a shared key that spans partitions or tenants.
   */
  partitionScoped: boolean;
  /**
   * C3: status and groups of exactly this person id in exactly this
   * partition, in one call, by Directory's own ids only: never by email,
   * Google id, alias or name. This read replaces the Entra guest check; it is
   * not optional. Return null (or throw) on a 404 and on any doubt.
   */
  readPersonAccess: (target: { partitionId: string; personId: string }) => Promise<DirectoryPersonAccess | null>;
}

/**
 * Group access for a linked Google principal. Absent = denied: every gated
 * surface is hidden for every Google principal (consumer contract §3). Needs
 * at least one tenant or partition.
 */
export interface LinkedDirectoryConfig {
  /** Customer Entra tenants, for links whose target is an Entra object. */
  tenants?: readonly LinkedDirectoryTenant[];
  /** 0.24.0. Customer Directory partitions, for links whose target is a Directory person. */
  partitions?: readonly LinkedDirectoryPartition[];
  /**
   * The app's Entra guest policy, applied to a linked Entra object with no
   * exception for the link (§3 rule 5). Default `true`, and it should match
   * the app's own `rejectGuests`. Never turn it off just to make Google work.
   * A Directory person has no guest type: its status read replaces this check.
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
   * plus at least 43 base64url characters. Never together with `caller`.
   */
  serviceKey?: string;
  /**
   * 0.18.0: prove this app to forit-Auth with a token from its own managed
   * identity, in place of `serviceKey` (Auth's row names this identity). The
   * only accepted value; never together with a key.
   */
  caller?: 'managed-identity';
  /**
   * Auth's caller app client id, a GUID, from `process.env.AUTH_MI_AUDIENCE`
   * Required deployment configuration; there is no default.
   * Required with `caller`. Not `audience`, which is this app's own origin.
   */
  authCallerAudience?: string;
  /**
   * Client id of this app's user-assigned identity, from
   * `process.env.AUTH_MI_CLIENT_ID`. Unset for the system-assigned identity.
   */
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

/**
 * How a live adapter proves itself to forit-Auth: its `fau_` key, or (0.18.0)
 * a managed identity token for Auth's caller audience, from a source built at
 * startup that fetches on first use.
 */
export type GoogleCallerProof =
  | { kind: 'key'; serviceKey: string }
  | { kind: 'identity'; audience: string; clientId: string | null; token: () => Promise<string> };

/** A checked configuration. Dormant ones carry nothing else. */
export type ResolvedGoogleConfig =
  | { live: false }
  | {
      live: true;
      proof: GoogleCallerProof;
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

/** Keyed by the link's labelled target: the kind picks the map, the id picks the entry. */
export interface ResolvedLinkedDirectory {
  /** `entra-object` links, keyed on the lower-case tenant id. */
  tenants: ReadonlyMap<string, LinkedDirectoryTenant>;
  /** 0.24.0. `directory-person` links, keyed on the lower-case partition id. */
  partitions: ReadonlyMap<string, LinkedDirectoryPartition>;
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
  if (!raw || typeof raw !== 'object') {
    refuse('linkedDirectory needs at least one tenant or partition; leave it unset to deny every linked principal.');
  }
  if (raw.tenants !== undefined && !Array.isArray(raw.tenants)) refuse('linkedDirectory.tenants must be a list.');
  if (raw.partitions !== undefined && !Array.isArray(raw.partitions)) refuse('linkedDirectory.partitions must be a list.');
  const rawTenants = raw.tenants ?? [];
  const rawPartitions = raw.partitions ?? [];
  if (rawTenants.length === 0 && rawPartitions.length === 0) {
    refuse('linkedDirectory needs at least one tenant or partition; leave it unset to deny every linked principal.');
  }
  if (raw.rejectGuests !== undefined && typeof raw.rejectGuests !== 'boolean') {
    refuse('linkedDirectory.rejectGuests must be a boolean.');
  }
  const tenants = new Map<string, LinkedDirectoryTenant>();
  for (const tenant of rawTenants) {
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
  const partitions = new Map<string, LinkedDirectoryPartition>();
  for (const partition of rawPartitions) {
    const id = typeof partition?.partitionId === 'string' ? partition.partitionId.toLowerCase() : '';
    if (!UUID.test(id)) refuse('linkedDirectory partitionId must be a Directory partition id (a GUID).');
    if (id === FORIT_TENANT_ID) {
      refuse('linkedDirectory cannot serve the ForIT tenant: a Google principal is never ForIT staff.');
    }
    if (partitions.has(id)) refuse('linkedDirectory lists a partition twice.');
    if (tenants.has(id)) {
      refuse('linkedDirectory lists one id as both a tenant and a partition: a customer has one group master.');
    }
    if (partition.partitionScoped !== true) {
      refuse("linkedDirectory partitions must use the partition's own scoped Directory key (partitionScoped: true).");
    }
    if (typeof partition.readPersonAccess !== 'function') {
      refuse('linkedDirectory needs readPersonAccess (status and groups by person id) for every partition.');
    }
    partitions.set(id, partition);
  }
  return { tenants, partitions, rejectGuests: raw.rejectGuests ?? true };
}

/** Unset, null or only spaces. */
function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

/**
 * Check a configuration once, when the handlers are built. Throws on any value
 * that could make the adapter trust the wrong thing, and on both proofs or a
 * half-set identity caller. Returns dormant for `enabled !== true` (nothing
 * else is read) and for neither a service key nor `caller`.
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

  // The proof: exactly one of a key and a managed identity (Auth's row names one).
  const key = config.serviceKey;
  const hasKey = !blank(key);
  const caller: unknown = config.caller;
  const hasCaller = caller !== undefined && caller !== null;
  const hasIdentitySetting = !blank(config.authCallerAudience) || !blank(config.managedIdentityClientId);
  if (hasKey && (hasCaller || hasIdentitySetting)) {
    refuse(
      "both proofs: serviceKey and a managed identity caller (caller, authCallerAudience or managedIdentityClientId) " +
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
