// ============================================================================
// @foritllc/auth - Sign-in transaction cookie (0.8.0)
//
// Binds a callback to the browser that started the sign-in. Before 0.8.0 the
// state nonce was generated and never checked, so anyone could hand a victim
// a callback URL carrying the ATTACKER's authorization code and the victim
// was silently signed in as the attacker (login CSRF).
//
// The login handler now mints three secrets, keeps them in a short-lived,
// HMAC-signed, HttpOnly cookie, and the callback refuses to redeem a code
// unless all three line up:
//   s — the `state` nonce (compared with the callback's `state`)
//   n — the OIDC `nonce` (compared with the validated id_token's `nonce`)
//   v — the PKCE `code_verifier` (sent with the code; Entra checks it)
// ============================================================================

import { signSessionPayload, verifySessionPayload } from './session-crypto.js';
import type { AuthConfig } from './types.js';

/** Long enough for a sign-in with MFA; short enough that a stray cookie dies. */
export const TX_MAX_AGE_SECONDS = 10 * 60;

/** Domain-separates a transaction cookie from a session cookie under the same key. */
const TX_TAG = 'tx:';

export interface SignInTransaction {
  /** State nonce. */
  s: string;
  /** OIDC nonce. */
  n: string;
  /** PKCE code_verifier. */
  v: string;
  /** Expiry, ms since epoch. */
  exp: number;
}

function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Constant-time string comparison (Edge-safe: no node:crypto). */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Mint a transaction plus the S256 PKCE challenge for its verifier. */
export async function newTransaction(now = Date.now()): Promise<{ tx: SignInTransaction; codeChallenge: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    tx: {
      s: crypto.randomUUID(),
      n: crypto.randomUUID(),
      v: verifier,
      exp: now + TX_MAX_AGE_SECONDS * 1000,
    },
    codeChallenge: base64url(new Uint8Array(digest)),
  };
}

export async function sealTransaction(tx: SignInTransaction): Promise<string> {
  return signSessionPayload(TX_TAG + btoa(JSON.stringify(tx)));
}

/** The transaction in a cookie value, or null if unsigned, tampered, malformed or expired. */
export async function openTransaction(value: string | undefined, now = Date.now()): Promise<SignInTransaction | null> {
  if (!value) return null;
  const payload = await verifySessionPayload(value);
  if (!payload || !payload.startsWith(TX_TAG)) return null;
  try {
    const tx = JSON.parse(atob(payload.slice(TX_TAG.length))) as Partial<SignInTransaction>;
    if (
      typeof tx.s !== 'string' || !tx.s ||
      typeof tx.n !== 'string' || !tx.n ||
      typeof tx.v !== 'string' || !tx.v ||
      typeof tx.exp !== 'number' || tx.exp < now
    ) {
      return null;
    }
    return tx as SignInTransaction;
  } catch {
    return null;
  }
}

/**
 * Cookie name for the transaction. `__Host-` on HTTPS without a shared
 * `cookieDomain`, so a sibling subdomain cannot plant one (cookie tossing);
 * with `cookieDomain` the cookie must carry `Domain`, which `__Host-` forbids.
 */
export function txCookieName(config: AuthConfig, baseUrl: string): string {
  const name = `${config.cookieName}_oauth`;
  return baseUrl.startsWith('https://') && !config.cookieDomain ? `__Host-${name}` : name;
}

/** Set-Cookie header for the transaction; pass `''` and maxAge 0 to clear it. */
export function txSetCookie(config: AuthConfig, baseUrl: string, value: string, maxAgeSec: number): string {
  const parts = [
    `${txCookieName(config, baseUrl)}=${value}`,
    'Path=/',
    'HttpOnly',
    // Lax, not Strict: the callback is a top-level navigation FROM
    // login.microsoftonline.com, and Strict would withhold the cookie there.
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (baseUrl.startsWith('https://')) parts.push('Secure');
  if (config.cookieDomain) parts.push(`Domain=${config.cookieDomain}`);
  return parts.join('; ');
}
