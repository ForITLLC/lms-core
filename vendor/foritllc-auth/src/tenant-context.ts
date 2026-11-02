// ============================================================================
// @foritllc/auth - Tenant Context Helper (0.2.0)
// Bridges auth → tenant-theme. Returns the resolution-key bundle that
// `@foritllc/tenant-theme`'s resolver consumes: tid (from session id_token),
// hostname (from request headers), plus the session itself for app-layer use.
// ============================================================================

import { cookies, headers } from 'next/headers.js';
import { assertSessionSecret } from './session-crypto.js';
import { parseSessionCookie } from './session-parse.js';
import type { AuthConfig, BaseSession } from './types.js';

/**
 * Resolution-key bundle for tenant-theme + tenant-branded email.
 * Shape is intentionally a superset of `@foritllc/tenant-theme`'s
 * `ResolveInput` — passing this object straight into `resolveTenantTheme`
 * works without further plumbing.
 */
export interface TenantContext {
  /** Azure AD tenant id from session id_token. Undefined for unauthenticated requests or sessions minted pre-0.2.0. */
  tid?: string;
  /** ForIT-internal tenant UUID (if app's onSessionCreated populated `session.tenant_id`). */
  tenant_id?: string;
  /** Lowercased host (port stripped). Pulled from `host` or `x-forwarded-host`. */
  hostname?: string;
  /** The signed session, or null when no valid cookie is present. */
  session: BaseSession | null;
}

/**
 * Create a server-side helper that returns the tenant resolution bundle
 * (tid + tenant_id + hostname + session). Intended for Server Components,
 * Route Handlers, and middleware in Next.js apps.
 *
 * Usage:
 * ```ts
 * import { createGetTenantContext } from '@foritllc/auth';
 * import { createTenantThemeResolver } from '@foritllc/tenant-theme';
 *
 * const getTenantContext = createGetTenantContext(authConfig);
 * const resolveTheme = createTenantThemeResolver({ pool });
 *
 * // In a Route Handler:
 * const ctx = await getTenantContext();
 * const theme = await resolveTheme(ctx);
 * ```
 */
export function createGetTenantContext(
  config: AuthConfig,
): () => Promise<TenantContext> {
  assertSessionSecret();
  return async (): Promise<TenantContext> => {
    let session: BaseSession | null = null;
    try {
      const cookieStore = await cookies();
      session = await parseSessionCookie(cookieStore.get(config.cookieName)?.value);
    } catch {
      session = null;
    }

    let hostname: string | undefined;
    try {
      const hdrs = await headers();
      const raw = hdrs.get('host') ?? hdrs.get('x-forwarded-host') ?? undefined;
      if (raw) hostname = raw.toLowerCase().split(':')[0];
    } catch {
      // headers() unavailable outside request scope — that's fine
    }

    const tid = typeof session?.tid === 'string' ? session.tid : undefined;
    const tenant_id =
      typeof session?.tenant_id === 'string' ? session.tenant_id : undefined;

    return { tid, tenant_id, hostname, session };
  };
}
