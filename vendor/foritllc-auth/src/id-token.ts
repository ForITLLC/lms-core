// ============================================================================
// @foritllc/auth - id_token validation (0.8.0)
//
// `tid` decides tenancy (allowedTenantIds, sessionInTenant, ForIT staff), so
// it must come from a token we validated, not from a base64 decode. Before
// 0.8.0 the callback read `tid` out of the id_token's payload with no check of
// signature, issuer, audience, expiry or nonce.
//
// Checks, in order: RS256 + kid, `tid` is a GUID, `iss` is exactly
// `https://login.microsoftonline.com/<tid>/v2.0`, `aud` is our client id,
// `exp`/`nbf` within 5 minutes of skew, `nonce` equals the one this browser's
// sign-in transaction holds, and the signature verifies against the tenant's
// published signing keys. Any failure throws IdTokenError.
//
// 0.24.2: the signing-keys fetch is `cache: 'no-store'`. Next.js patches the
// global fetch with its Data Cache, which keeps a Route Handler's GET on disk
// across requests and restarts, so after Microsoft rotated its keys every
// refetch here was served the same stale list and every sign-in failed
// unknown_kid. The first unknown kid after a
// fetch now refetches once the list is 5 s old, and the error names the kid
// and the kids the list holds.
//
// 0.29.2: a kid missing from the tenant's list is looked up in Microsoft's
// shared /organizations list before the token is refused. Regional key-list
// inconsistency can otherwise refuse a valid token as unknown_kid.
// Every other check is unchanged: the issuer must
// still name the token's own tenant, and the signature must verify against the
// key found. The shared list has its own cache and the same refetch floors, and
// if it cannot be read the tenant's answer stands.
//
// 0.29.3: 0.29.2 was not enough. Entra slices on build 2.1.25515.x left the
// same key out of the tenant, /organizations and /common lists alike, while
// slices on 2.1.25449.8 listed it in all three, and a request lands on either.
// Now every key read from any Microsoft list is kept by kid for 24 h, so one
// good read outlasts a bad slice, and a kid found nowhere starts one wide
// lookup: the tenant, /organizations and /common lists, read twice each in
// parallel, at most once per 15 s and one run at a time. Only a key Microsoft
// published can verify; the issuer, audience, nonce and expiry checks are
// unchanged.
// ============================================================================

import { constantTimeEqual } from './oauth-transaction.js';
import { entraIssuer } from './identity.js';

const CLOCK_SKEW_SEC = 300;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** A kid we don't know triggers a refetch, at most this often per tenant... */
const JWKS_MIN_REFETCH_MS = 60 * 1000;
/**
 * ...except the first unknown kid after a fetch, which may refetch this soon:
 * a real rotation costs one refused request, not a minute of them, and a
 * burst of bogus kids still buys at most one extra fetch per minute.
 */
const JWKS_ROTATION_REFETCH_MS = 5 * 1000;
/** Microsoft's shared signing-key lists, read with the tenant's own list when it lacks a kid. */
const SHARED_KEY_LISTS = ['organizations', 'common'] as const;
/** How many times a wide lookup reads each list, in parallel (each read may land on another slice). */
const WIDE_LOOKUP_READS = 2;
/** A wide lookup for a missing kid starts at most this often. */
const WIDE_LOOKUP_MIN_MS = 15 * 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IdTokenError extends Error {
  /** For unknown_kid: the kid the token names and the kids the fetched list holds. */
  readonly kid?: string;
  readonly knownKids?: readonly string[];
  /**
   * @param reason   why the token was refused (stable, for logs)
   * @param upstreamStatus  HTTP status of the signing-keys fetch when that is
   *   what failed (429 = throttled, transient; 4xx = bad tenant; 5xx = Entra
   *   down), so a caller can tell them apart without parsing `reason`.
   * @param keys  for unknown_kid: which kid is missing and which kids the
   *   last fetch returned, so the callback's log says what to compare.
   */
  constructor(
    public readonly reason: string,
    public readonly upstreamStatus?: number,
    keys?: { kid: string; knownKids: string[] },
  ) {
    super(
      keys
        ? `id_token rejected: ${reason} (kid ${keys.kid}; published: ${keys.knownKids.join(', ') || 'none'})`
        : `id_token rejected: ${reason}`,
    );
    this.name = 'IdTokenError';
    if (keys) {
      this.kid = keys.kid;
      this.knownKids = keys.knownKids;
    }
  }
}

export interface ValidatedIdToken {
  iss: string;
  tid: string;
  aud: string;
  exp: number;
  nonce: string;
  oid?: string;
  [claim: string]: unknown;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface JwksEntry {
  fetchedAt: number;
  keys: Map<string, Jwk>;
  /** Fetched for a kid the previous list lacked; the next such refetch waits the full floor. */
  forUnknownKid: boolean;
}

const jwksCache = new Map<string, JwksEntry>();
/**
 * Every key read from any Microsoft list, by kid, kept until JWKS_TTL_MS after
 * the last read that listed it, so one good read outlasts a slice that omits it.
 */
const seenKeys = new Map<string, { jwk: Jwk; seenAt: number }>();
let wideLookupAt = -Infinity;
let wideLookupRun: Promise<void> | null = null;

/** Test hook: forget every cached signing key. */
export function clearJwksCache(): void {
  jwksCache.clear();
  seenKeys.clear();
  wideLookupAt = -Infinity;
  wideLookupRun = null;
}

function seenKey(kid: string, now: number): Jwk | undefined {
  const seen = seenKeys.get(kid);
  return seen && now - seen.seenAt <= JWKS_TTL_MS ? seen.jwk : undefined;
}

/** Read the tenant's list and the shared lists several times at once; one run at a time, failures ignored. */
function wideLookup(tid: string, now: number): Promise<void> {
  if (wideLookupRun) return wideLookupRun;
  if (now - wideLookupAt < WIDE_LOOKUP_MIN_MS) return Promise.resolve();
  wideLookupAt = now;
  const reads: Promise<unknown>[] = [];
  for (let i = 0; i < WIDE_LOOKUP_READS; i++) {
    for (const list of [tid, ...SHARED_KEY_LISTS]) reads.push(fetchJwks(list, now).catch(() => undefined));
  }
  const run = Promise.all(reads).then(() => undefined);
  wideLookupRun = run;
  void run.finally(() => {
    if (wideLookupRun === run) wideLookupRun = null;
  });
  return run;
}

function segmentBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(segmentBytes(segment)));
}

async function fetchJwks(source: string, now: number, forUnknownKid = false): Promise<JwksEntry> {
  let res: Response;
  try {
    // no-store: a framework that patches the global fetch with a persistent
    // data cache (Next.js) must never answer this from an old key list.
    res = await fetch(`https://login.microsoftonline.com/${source}/discovery/v2.0/keys`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new IdTokenError(`signing keys unavailable (${(err as Error).message})`);
  }
  if (!res.ok) {
    const upstreamStatus = res.status;
    throw new IdTokenError('signing keys unavailable', upstreamStatus);
  }
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, Jwk>();
  for (const k of body.keys ?? []) {
    if (k.kty === 'RSA' && typeof k.kid === 'string' && k.n && k.e) keys.set(k.kid, k);
  }
  for (const [kid, jwk] of keys) seenKeys.set(kid, { jwk, seenAt: now });
  const entry = { fetchedAt: now, keys, forUnknownKid };
  jwksCache.set(source, entry);
  return entry;
}

/** The tenant's key list, refetched on expiry or for an unknown kid. */
async function keyList(source: string, kid: string, now: number): Promise<JwksEntry> {
  let entry = jwksCache.get(source);
  if (!entry || now - entry.fetchedAt > JWKS_TTL_MS) {
    entry = await fetchJwks(source, now);
  } else if (!entry.keys.has(kid)) {
    const floor = entry.forUnknownKid ? JWKS_MIN_REFETCH_MS : JWKS_ROTATION_REFETCH_MS;
    if (now - entry.fetchedAt > floor) entry = await fetchJwks(source, now, true); // key rotation
  }
  return entry;
}

async function signingKey(tid: string, kid: string, now: number): Promise<CryptoKey> {
  const entry = await keyList(tid, kid, now);
  // Entra's slices can disagree about a key (2026-11-16): any list that named it lately counts, then a wide lookup.
  let jwk = entry.keys.get(kid) ?? seenKey(kid, now);
  if (!jwk) {
    await wideLookup(tid, now);
    jwk = seenKey(kid, now);
  }
  if (!jwk) {
    const tenantKids = [...(jwksCache.get(tid) ?? entry).keys.keys()];
    console.warn(
      `[forit/auth] signing key not found: kid=${kid} tenantKids=${tenantKids.join(',')} seenKids=${[...seenKeys.keys()].join(',')}`,
    );
    throw new IdTokenError('unknown_kid', undefined, { kid, knownKids: tenantKids });
  }
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
}

/**
 * Validate an Entra ID v2.0 id_token for this client and sign-in transaction.
 * Returns its claims; throws IdTokenError on any failure.
 */
export async function validateIdToken(
  idToken: unknown,
  expected: { clientId: string; nonce: string },
  now = Date.now(),
): Promise<ValidatedIdToken> {
  if (typeof idToken !== 'string') throw new IdTokenError('missing');
  const parts = idToken.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw new IdTokenError('malformed');

  let header: { alg?: unknown; kid?: unknown };
  let claims: Record<string, unknown>;
  try {
    header = decodeSegment(parts[0]) as typeof header;
    claims = decodeSegment(parts[1]) as Record<string, unknown>;
  } catch {
    throw new IdTokenError('malformed');
  }
  if (!claims || typeof claims !== 'object') throw new IdTokenError('malformed');
  if (header.alg !== 'RS256') throw new IdTokenError('alg');
  if (typeof header.kid !== 'string' || !header.kid) throw new IdTokenError('kid');

  const { tid, iss, aud, exp, nbf, nonce } = claims;
  if (typeof tid !== 'string' || !GUID.test(tid)) throw new IdTokenError('tid');
  if (typeof iss !== 'string' || iss.toLowerCase() !== entraIssuer(tid)) throw new IdTokenError('issuer');
  const audience = Array.isArray(aud) && aud.length === 1 ? aud[0] : aud;
  if (audience !== expected.clientId) throw new IdTokenError('audience');
  const nowSec = now / 1000;
  if (typeof exp !== 'number' || exp + CLOCK_SKEW_SEC < nowSec) throw new IdTokenError('expired');
  if (typeof nbf === 'number' && nbf - CLOCK_SKEW_SEC > nowSec) throw new IdTokenError('not_yet_valid');
  if (typeof nonce !== 'string' || !constantTimeEqual(nonce, expected.nonce)) throw new IdTokenError('nonce');

  const key = await signingKey(tid.toLowerCase(), header.kid, now);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      segmentBytes(parts[2]) as unknown as ArrayBuffer,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
  } catch {
    valid = false;
  }
  if (!valid) throw new IdTokenError('signature');

  return { ...claims, iss, tid, aud: audience, exp, nonce } as ValidatedIdToken;
}
