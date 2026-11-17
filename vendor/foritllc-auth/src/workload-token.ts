// ============================================================================
// @foritllc/auth - Workload token receiver (0.19.0)
// metered-call-guard: not-metered Microsoft Entra public signing-key discovery has no per-call charge.
//
// One app calls another as itself: the caller asks its host (App Service,
// Functions, Container Apps) for a managed-identity access token for the
// receiver's audience and sends it as `Authorization: Bearer <jws>`. The
// caller side is a separate change; this file is the receiver. It answers WHICH
// reviewed caller sent the token, or null, and nothing else: token roles and
// scopes never grant anything here, only the receiver's own policy does.
//
// Ported from forit-Auth's createManagedIdentityResolver
// (for-Auth src/lib/managedIdentity.ts), its checks kept and two made
// stricter by for-Architecture's ruling (2026-11-03, assessment
// 2026-11-03-auth-managed-identity-approach.md, source 29f02e6):
//
//   - the policy is trusted process configuration, re-read on every call;
//     a missing or invalid policy denies before any network call
//   - token at most 16384 bytes, compact JWS form only
//   - header: RS256 only; jku, jwk and x5u refused (keys come only from
//     Microsoft's fixed endpoint for the policy's tenant)
//   - v2 tokens only (ruling): `ver` must be 2.0, the issuer exactly
//     `https://login.microsoftonline.com/<tenantId>/v2.0`, keys from the
//     tenant's v2.0 discovery URL. A v1 token is refused before any fetch.
//   - jose jwtVerify: issuer, audience, RS256, clock tolerance 0, required
//     iss/aud/tid/oid/ver/iat/nbf/exp/azp/idtyp
//   - after the signature: ver, aud (a string, exactly the policy's), tid,
//     oid and azp again, and appid too when present; any `scp` (a
//     delegated, user token) refused; `idtyp` must be exactly `app` and
//     must be there (ruling; the reference allowed it to be missing)
//   - iat/nbf/exp positive integers, iat and nbf not in the future, both
//     before exp, lifetime at most 86700 seconds (a day plus Entra's 300 s skew)
//   - Microsoft Graph and Azure Resource Manager are never a policy audience
//   - at most 8 cached key sets per verifier
//
// What else changed from the original: a policy names up to 32 callers
// instead of one, and the token must match ONE entry on both its object id
// and its client id. forit-Auth's vault scopes, consumer slug and region
// rules are Auth's own and are not here. Any failure returns null; nothing
// throws out of a verifier and nothing is logged, the token least of all.
//
// The receiving app's registration must issue v2 access tokens
// (`api.requestedAccessTokenVersion: 2`) and carry the `idtyp` optional
// claim on access tokens, or every token is refused.
// ============================================================================

import type * as Jose from 'jose';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const POLICY_FIELDS = ['tenantId', 'audience', 'callers'] as const;
const CALLER_FIELDS = ['name', 'objectId', 'clientId'] as const;
const MAX_POLICY_CHARS = 8192;
const MAX_CALLERS = 32;
const MAX_NAME_CHARS = 64;
const MAX_AUDIENCE_CHARS = 512;
const MAX_TOKEN_BYTES = 16384;
// A managed-identity access token lives a day plus Entra's 300 s clock skew: 86,700 s from iat
// and from nbf (0.29.1, Tasks 0186D7D4). Reject anything longer, unbounded or inconsistent.
const MAX_TOKEN_SKEW_SECONDS = 300;
const MAX_TOKEN_LIFETIME_SECONDS = 86400 + MAX_TOKEN_SKEW_SECONDS;
const MAX_KEY_SETS = 8;
const TOKEN_EXCHANGE = 'api://azureadtokenexchange';

/**
 * Microsoft's own APIs. A token for one of them is meant for Microsoft, so an
 * app must never accept it as a call to itself. Compared lowercased.
 */
const FIRST_PARTY_AUDIENCES = new Set([
  '00000003-0000-0000-c000-000000000000', 'https://graph.microsoft.com', 'https://graph.microsoft.com/',
  '797f4846-ba00-4fd7-ba43-dac1f8f63013',
  'https://management.azure.com', 'https://management.azure.com/',
  'https://management.core.windows.net', 'https://management.core.windows.net/',
]);

/**
 * Why `value` cannot be an app's own audience, or null when it can. Used by
 * the receiver's policy; not exported from the package entries.
 * @internal
 */
export function workloadAudienceProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return 'is empty or not a string';
  if (value.length > MAX_AUDIENCE_CHARS) return `is longer than ${MAX_AUDIENCE_CHARS} characters`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return 'contains whitespace or a control character';
  const lower = value.toLowerCase();
  if (FIRST_PARTY_AUDIENCES.has(lower)) return 'is Microsoft Graph or Azure Resource Manager';
  if (lower === TOKEN_EXCHANGE) return 'is the federated-credential exchange audience';
  return null;
}

/** One app allowed to call: its managed identity's object id and client id. */
export interface WorkloadCaller {
  /** Kebab-case label, unique in the policy; returned to the receiver. */
  name: string;
  /** The managed identity's object (principal) id: the token's `oid`. */
  objectId: string;
  /** The managed identity's client (application) id: the token's `azp`. */
  clientId: string;
}

export interface WorkloadTokenPolicy {
  /** The Entra tenant the callers' identities live in (the token's `tid`). */
  tenantId: string;
  /**
   * The receiver's own audience, compared exactly with the token's `aud`.
   * Entra writes the receiving registration's client id there in a v2
   * token, whichever form of it the caller asked for.
   */
  audience: string;
  /** 1 to 32 callers. */
  callers: WorkloadCaller[];
}

/** The caller a verified token belongs to. GUIDs lowercased. */
export interface VerifiedWorkloadCaller {
  name: string;
  objectId: string;
  clientId: string;
  tenantId: string;
}

/** The transport jose hands the key-set request to (tests inject one). */
export type WorkloadKeyFetch = (
  url: string,
  options: { headers: Headers; method: 'GET'; redirect: 'manual'; signal: AbortSignal },
) => Promise<Response>;

export interface WorkloadTokenVerifierOptions {
  /**
   * A policy, or a function that returns one on every call (null denies).
   * Trusted configuration only, never a request header or a claim. A static
   * policy that fails `parseWorkloadTokenPolicy` throws here, at creation.
   */
  policy: WorkloadTokenPolicy | (() => WorkloadTokenPolicy | null);
  /** Epoch seconds. Default: the clock. */
  now?: () => number;
  /** Trusted transport for the signing-key fetch, for offline tests. */
  fetch?: WorkloadKeyFetch;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const hasExactly = (value: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));

const isGuid = (value: unknown): value is string => typeof value === 'string' && GUID.test(value);

/**
 * A workload policy from a JSON string (at most 8192 characters) or an
 * object, or null. Strict: exactly `tenantId`, `audience` and `callers`; each
 * caller exactly `name`, `objectId` and `clientId`; GUIDs come back
 * lowercased; names are unique kebab-case (at most 64 characters); no object
 * id or client id appears twice. Returns a fresh copy every time.
 */
export function parseWorkloadTokenPolicy(raw: unknown): WorkloadTokenPolicy | null {
  try {
    let parsed: unknown = raw;
    if (typeof raw === 'string') {
      if (!raw || raw.length > MAX_POLICY_CHARS) return null;
      parsed = JSON.parse(raw);
    }
    if (!isPlainObject(parsed) || !hasExactly(parsed, POLICY_FIELDS)) return null;
    const { tenantId, audience, callers } = parsed;
    if (!isGuid(tenantId) || workloadAudienceProblem(audience) !== null) return null;
    if (!Array.isArray(callers) || callers.length < 1 || callers.length > MAX_CALLERS) return null;
    const names = new Set<string>();
    const ids = new Set<string>();
    const out: WorkloadCaller[] = [];
    for (const caller of callers) {
      if (!isPlainObject(caller) || !hasExactly(caller, CALLER_FIELDS)) return null;
      const { name, objectId, clientId } = caller;
      if (typeof name !== 'string' || name.length > MAX_NAME_CHARS || !KEBAB.test(name)) return null;
      if (!isGuid(objectId) || !isGuid(clientId)) return null;
      const oid = objectId.toLowerCase();
      const cid = clientId.toLowerCase();
      if (names.has(name) || ids.has(oid) || ids.has(cid) || oid === cid) return null;
      names.add(name);
      ids.add(oid);
      ids.add(cid);
      out.push({ name, objectId: oid, clientId: cid });
    }
    return { tenantId: tenantId.toLowerCase(), audience: audience as string, callers: out };
  } catch {
    return null;
  }
}

let joseModule: Promise<typeof Jose> | undefined;
function loadJose(): Promise<typeof Jose> {
  joseModule ??= import('jose').catch(error => {
    joseModule = undefined;
    throw error;
  });
  return joseModule;
}

/**
 * A function that verifies an Entra v2 managed-identity (app-only) access
 * token and answers which policy caller sent it, or null. The caller matches
 * when ONE entry has both the token's `oid` and its `azp` (and `appid`, when
 * the token has one). Never throws and never logs.
 */
export function createWorkloadTokenVerifier(
  options: WorkloadTokenVerifierOptions,
): (token: string) => Promise<VerifiedWorkloadCaller | null> {
  const source = options?.policy;
  let readPolicy: () => WorkloadTokenPolicy | null;
  if (typeof source === 'function') {
    readPolicy = () => parseWorkloadTokenPolicy(source());
  } else {
    const fixed = parseWorkloadTokenPolicy(source);
    if (!fixed) {
      throw new Error(
        '[forit/auth] createWorkloadTokenVerifier: policy is not a valid WorkloadTokenPolicy ' +
          '(exactly tenantId, audience and 1-32 callers; see parseWorkloadTokenPolicy).',
      );
    }
    // `fixed` is this verifier's own copy and is never handed out.
    readPolicy = () => fixed;
  }
  const keySets = new Map<string, ReturnType<typeof Jose.createRemoteJWKSet>>();

  return async token => {
    try {
      const policy = readPolicy();
      if (!policy || typeof token !== 'string' || !token || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES ||
          !COMPACT_JWS.test(token)) return null;
      const now = (options.now ?? (() => Math.floor(Date.now() / 1000)))();
      if (!Number.isSafeInteger(now) || now <= 0) return null;
      const jose = await loadJose();
      const header = jose.decodeProtectedHeader(token);
      if (header.alg !== 'RS256' || ['jku', 'jwk', 'x5u'].some(field => Object.hasOwn(header, field))) return null;
      // v2 only (Architecture ruling): a v1 token is refused before any key fetch. All identity
      // claims, including this version, are checked again after signature verification.
      if (jose.decodeJwt(token).ver !== '2.0') return null;
      const issuer = `https://login.microsoftonline.com/${policy.tenantId}/v2.0`;
      const jwksUrl = `https://login.microsoftonline.com/${policy.tenantId}/discovery/v2.0/keys`;
      let keys = keySets.get(jwksUrl);
      if (!keys) {
        keys = jose.createRemoteJWKSet(new URL(jwksUrl), {
          timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
          ...(options.fetch ? { [jose.customFetch]: options.fetch } : {}),
        });
        if (keySets.size >= MAX_KEY_SETS) keySets.delete(keySets.keys().next().value!);
        keySets.set(jwksUrl, keys);
      }
      const { payload } = await jose.jwtVerify(token, keys, {
        issuer, audience: policy.audience, algorithms: ['RS256'], currentDate: new Date(now * 1000), clockTolerance: 0,
        requiredClaims: ['iss', 'aud', 'tid', 'oid', 'ver', 'iat', 'nbf', 'exp', 'azp', 'idtyp'],
      });
      const oid = payload.oid;
      const caller = isGuid(oid) ? policy.callers.find(entry => entry.objectId === oid.toLowerCase()) : undefined;
      if (!caller) return null;
      const sameGuid = (value: unknown, expected: string) => isGuid(value) && value.toLowerCase() === expected;
      if (payload.ver !== '2.0' || payload.iss !== issuer || payload.aud !== policy.audience ||
          !sameGuid(payload.tid, policy.tenantId) || !sameGuid(payload.oid, caller.objectId) ||
          !sameGuid(payload.azp, caller.clientId) ||
          (Object.hasOwn(payload, 'appid') && !sameGuid(payload.appid, caller.clientId)) ||
          Object.hasOwn(payload, 'scp') || payload.idtyp !== 'app') return null;
      const { iat, nbf, exp } = payload;
      if (![iat, nbf, exp].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) ||
          iat! >= exp! || nbf! >= exp! || iat! > now || nbf! > now ||
          exp! - Math.min(iat!, nbf!) > MAX_TOKEN_LIFETIME_SECONDS) return null;
      // Token roles/scopes never become capabilities. Only the reviewed policy names the caller.
      return { name: caller.name, objectId: caller.objectId, clientId: caller.clientId, tenantId: policy.tenantId };
    } catch {
      // Configuration, signature and key-infrastructure failures all deny without token/error logs.
      return null;
    }
  };
}

const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/;

/**
 * The token from an `Authorization` header of exactly `Bearer <jws>` (one
 * space, compact JWS, nothing before or after), or null. Not a check of the
 * token: hand the result to a verifier.
 */
export function bearerFromAuthorization(header: string | null | undefined): string | null {
  if (typeof header !== 'string' || header.length > MAX_TOKEN_BYTES + 7) return null;
  const match = BEARER.exec(header);
  return match ? match[1] : null;
}
