// ============================================================================
// @foritllc/auth - Session cookie parsing (0.8.0)
// The ONE reader every surface uses: middleware, getSession, the `me` route
// and the tenant context. Edge-safe.
// ============================================================================

import { sessionTenantValidated } from './identity.js';
import { verifySessionPayload } from './session-crypto.js';
import type { BaseSession } from './types.js';

/**
 * The session in a signed cookie value, or null when the signature is bad,
 * the payload is malformed, it has expired, or (0.8.0+) its `tid` was not
 * taken from a validated id_token. The last rule signs out every session
 * minted before 0.8.0 once, so nobody keeps tenant access on an unchecked
 * `tid`: pages bounce to sign-in, APIs answer 401.
 */
export async function parseSessionCookie(cookieValue: string | undefined): Promise<BaseSession | null> {
  if (!cookieValue) return null;
  try {
    const base64Payload = await verifySessionPayload(cookieValue);
    if (!base64Payload) return null;
    const session = JSON.parse(Buffer.from(base64Payload, 'base64').toString()) as BaseSession;
    if (!session || typeof session !== 'object') return null;
    if (typeof session.expiresAt !== 'number' || session.expiresAt < Date.now()) return null;
    if (!sessionTenantValidated(session)) return null;
    return session;
  } catch {
    return null;
  }
}
