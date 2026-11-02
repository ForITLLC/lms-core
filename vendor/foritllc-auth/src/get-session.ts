// ============================================================================
// @foritllc/auth - Server-side Session Helper
// Reads the session cookie from next/headers for use in Server Components
// and Route Handlers.
// ============================================================================

import { cookies } from 'next/headers.js';
import { assertSessionSecret } from './session-crypto.js';
import { parseSessionCookie } from './session-parse.js';
import type { AuthConfig, BaseSession } from './types.js';

/**
 * Create a server-side helper that reads the HMAC-signed session cookie
 * and returns a typed BaseSession, or null if not authenticated / expired
 * (or, 0.8.0+, minted without a validated id_token — see parseSessionCookie).
 *
 * Usage in a consuming app:
 * ```ts
 * import { createGetSession } from '@foritllc/auth';
 * const getSession = createGetSession(authConfig);
 *
 * // In a Server Component or Route Handler:
 * const session = await getSession();
 * ```
 */
export function createGetSession(
  config: AuthConfig
): () => Promise<BaseSession | null> {
  assertSessionSecret();
  return async (): Promise<BaseSession | null> => {
    try {
      const cookieStore = await cookies();
      return await parseSessionCookie(cookieStore.get(config.cookieName)?.value);
    } catch {
      return null;
    }
  };
}
