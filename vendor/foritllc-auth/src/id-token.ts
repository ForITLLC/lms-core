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
// ============================================================================

import { constantTimeEqual } from './oauth-transaction.js';
import { entraIssuer } from './identity.js';

const CLOCK_SKEW_SEC = 300;
const JWKS_TTL_MS = 24 * 60 * 60 * 1000;
/** A kid we don't know triggers a refetch, at most this often per tenant. */
const JWKS_MIN_REFETCH_MS = 60 * 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class IdTokenError extends Error {
  /**
   * @param reason   why the token was refused (stable, for logs)
   * @param upstreamStatus  HTTP status of the signing-keys fetch when that is
   *   what failed (429 = throttled, transient; 4xx = bad tenant; 5xx = Entra
   *   down), so a caller can tell them apart without parsing `reason`.
   */
  constructor(public readonly reason: string, public readonly upstreamStatus?: number) {
    super(`id_token rejected: ${reason}`);
    this.name = 'IdTokenError';
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
}

const jwksCache = new Map<string, JwksEntry>();

/** Test hook: forget every cached signing key. */
export function clearJwksCache(): void {
  jwksCache.clear();
}

function segmentBytes(segment: string): Uint8Array {
  const b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function decodeSegment(segment: string): unknown {
  return JSON.parse(new TextDecoder().decode(segmentBytes(segment)));
}

async function fetchJwks(tid: string, now: number): Promise<JwksEntry> {
  let res: Response;
  try {
    res = await fetch(`https://login.microsoftonline.com/${tid}/discovery/v2.0/keys`, {
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
  const entry = { fetchedAt: now, keys };
  jwksCache.set(tid, entry);
  return entry;
}

async function signingKey(tid: string, kid: string, now: number): Promise<CryptoKey | null> {
  let entry = jwksCache.get(tid);
  if (!entry || now - entry.fetchedAt > JWKS_TTL_MS) {
    entry = await fetchJwks(tid, now);
  } else if (!entry.keys.has(kid) && now - entry.fetchedAt > JWKS_MIN_REFETCH_MS) {
    entry = await fetchJwks(tid, now); // key rotation
  }
  const jwk = entry.keys.get(kid);
  if (!jwk) return null;
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
  if (!key) throw new IdTokenError('unknown_kid');
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
