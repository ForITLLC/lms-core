// ============================================================================
// @foritllc/auth - Middleware Factory
// Returns a Next.js middleware function that protects routes via HMAC cookies.
// ============================================================================

import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import { isForitStaffSession } from './identity.js';
import { assertSessionSecret } from './session-crypto.js';
import { parseSessionCookie } from './session-parse.js';
import type { AuthConfig } from './types.js';

/**
 * Check whether a pathname matches any of the given path prefixes, on a
 * path-segment boundary: `/api` matches `/api` and `/api/x`, never `/apix`.
 * `/` matches only `/`: as a prefix it would also match `//x`, which Next
 * redirects today, but a public path must not depend on that.
 */
function matchesPaths(pathname: string, paths: string[]): boolean {
  return paths.some((p) =>
    p === '/' ? pathname === '/' : pathname === p || pathname.startsWith(p + '/')
  );
}

/** `publicPaths` when the app sets none: the sign-in page and the OAuth routes. */
export const DEFAULT_PUBLIC_PATHS = ['/', '/api/auth'];

/**
 * Static asset paths that always pass through without auth, matched on a
 * path boundary (0.10.0; before it `/static` also let `/staticx` through).
 */
const STATIC_PREFIXES = ['/_next', '/static'];

/** `/favicon.ico`, `/favicon.svg`, `/favicon-32x32.png`: one segment, an icon extension. */
const FAVICON = /^\/favicon[\w-]*\.(?:ico|png|svg)$/;

/**
 * What the middleware does with a path, decided before it reads a cookie:
 *
 * - `static`: a Next build asset or favicon; passes.
 * - `public`: on `publicPaths`; passes.
 * - `staff`: on `staffPaths`; needs a ForIT-tenant session (wins over public).
 * - `session`: needs a session; every other path under `defaultDeny`, else
 *   only `protectedPaths`.
 * - `open`: passes with no check. Only without `defaultDeny`.
 *
 * Exported so an app's route-walk test can assert that every page and route
 * it ships is `session`, `staff` or a deliberate `public`.
 */
export type RouteAccess = 'static' | 'public' | 'staff' | 'session' | 'open';

export function routeAccess(
  config: Pick<AuthConfig, 'defaultDeny' | 'protectedPaths' | 'publicPaths' | 'staffPaths'>,
  pathname: string
): RouteAccess {
  if (matchesPaths(pathname, STATIC_PREFIXES) || FAVICON.test(pathname)) {
    return 'static';
  }
  if (matchesPaths(pathname, config.staffPaths ?? [])) return 'staff';
  if (matchesPaths(pathname, config.publicPaths ?? DEFAULT_PUBLIC_PATHS)) return 'public';
  if (config.defaultDeny || matchesPaths(pathname, config.protectedPaths ?? [])) {
    return 'session';
  }
  return 'open';
}

let warnedAllowByDefault = false;

/**
 * Create a Next.js middleware function that enforces authentication via
 * HMAC-signed session cookies.
 *
 * - With `defaultDeny` (0.10.0+), every path needs a valid session unless it
 *   is a static asset or on `publicPaths`. Without it, only `protectedPaths`
 *   do and every other path passes (allow-by-default, forit-Common#284).
 * - With no session, `/api/*` gets 401 JSON and a page redirects (303) to
 *   `/?returnTo=`.
 * - Staff paths (0.8.0+) additionally require a ForIT staff session
 *   (`isForitStaffSession`: the ForIT tenant, by validated `tid`). Anyone
 *   else gets 403 JSON on `/api/*` and a redirect to `errorPath?error=staff_only`
 *   on pages. Staff paths win over public paths.
 *
 * The middleware only sees the paths the app's own `config.matcher` sends it.
 */
export function createAuthMiddleware(
  config: AuthConfig
): (req: NextRequest) => Promise<NextResponse> {
  assertSessionSecret();
  if (config.defaultDeny) {
    assertSignInIsPublic(config);
  } else if (!warnedAllowByDefault) {
    warnedAllowByDefault = true;
    console.warn(
      '[forit/auth] middleware is allow-by-default: a path not on protectedPaths or staffPaths needs no session. Set defaultDeny: true (the default from 1.0.0; forit-Common#284).'
    );
  }

  return async (request: NextRequest): Promise<NextResponse> => {
    const { pathname } = request.nextUrl;
    const access = routeAccess(config, pathname);

    if (access !== 'session' && access !== 'staff') {
      return NextResponse.next();
    }

    const sessionCookie = request.cookies.get(config.cookieName);
    const session = await parseSessionCookie(sessionCookie?.value);

    if (!session) {
      // API routes get 401 JSON
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'Not authenticated', code: 'UNAUTHENTICATED' },
          { status: 401 }
        );
      }

      // Page routes redirect to login
      const loginUrl = new URL('/', request.url);
      loginUrl.searchParams.set('returnTo', pathname);
      return NextResponse.redirect(loginUrl, { status: 303 });
    }

    if (access === 'staff' && !isForitStaffSession(session)) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json(
          { error: 'ForIT staff only', code: 'FORBIDDEN' },
          { status: 403 }
        );
      }
      const deniedUrl = new URL(config.errorPath ?? '/', request.url);
      deniedUrl.searchParams.set('error', 'staff_only');
      return NextResponse.redirect(deniedUrl, { status: 303 });
    }

    return NextResponse.next();
  };
}

/**
 * Under `defaultDeny` the sign-in page and the OAuth routes must stay
 * reachable with no session: a denied `/` redirects to `/?returnTo=/` forever,
 * and a denied `/api/auth/login` means nobody can sign in. An app that sets
 * `publicPaths` replaces the default, so it has to list them itself; this
 * throws at startup when it didn't. A custom `errorPath` is checked too: the
 * callback sends a signed-out browser there with the error code.
 */
function assertSignInIsPublic(config: AuthConfig): void {
  const required = ['/', '/api/auth/login', '/api/auth/callback'];
  if (config.errorPath) required.push(new URL(config.errorPath, 'https://x.invalid').pathname);
  const missing = required.filter((p) => routeAccess(config, p) !== 'public');
  if (missing.length > 0) {
    throw new Error(
      `[forit/auth] defaultDeny: ${missing.join(', ')} would need a session, so nobody could sign in. ` +
        `publicPaths replaces the default ['/', '/api/auth']; include both (and errorPath, if set), and keep them off staffPaths.`
    );
  }
}
