// ============================================================================
// @foritllc/auth - Microsoft and Google in one middleware (0.14.0, opt-in)
//
// For an app that offers Google sign-in beside Microsoft. Each provider keeps
// its own cookie and its own checks; this only decides which one reads a
// request. `createAuthMiddleware` is unchanged and still does all the
// Microsoft work: a request goes to it exactly as before unless it carries a
// Google cookie, no Microsoft cookie, and asks for a `session` path.
//
// Nothing here falls back from one provider to the other. A Google cookie that
// does not verify gets Google's own answer (401, 503 or a redirect), never a
// Microsoft one, and a Microsoft cookie is never read as Google. Staff paths
// never ask Google: only a Microsoft session from the ForIT tenant passes.
//
// Only types come from ./google.js, so the main entry loads no Google code.
// ============================================================================

import { NextResponse } from 'next/server.js';
import type { NextRequest } from 'next/server.js';
import type { GoogleSignInHandlers } from './google.js';
import { createAuthMiddleware, routeAccess } from './middleware.js';
import { parseSessionCookie } from './session-parse.js';
import type { AuthConfig } from './types.js';

/** The two parts of a Google adapter the combined middleware uses. */
export type CombinedGoogleSignIn = Pick<GoogleSignInHandlers, 'cookieName' | 'requireGoogleSession'>;

/**
 * A Next.js middleware that lets a Google user through `session` paths and
 * leaves everything else to `createAuthMiddleware(config)`.
 *
 * A request takes the Google branch only when all of these hold: the adapter
 * names a cookie (a dormant one names none), that name differs from
 * `config.cookieName`, the request has no Microsoft cookie, it has the Google
 * cookie, and `routeAccess` says `session`. Then `requireGoogleSession` asks
 * forit-Auth and its answer is the middleware's answer. Every other request,
 * staff, public and static paths included, gets exactly what
 * `createAuthMiddleware` gives it, with one addition: when it refuses a
 * Microsoft cookie that does not verify and the request also has the Google
 * cookie, the refusal deletes that Microsoft cookie. The request is still
 * refused; the next one has only the Google cookie and is read as Google
 * instead of being sent back to sign-in. A Microsoft cookie that verifies is
 * never deleted.
 *
 * Google's CSRF rule applies here too. On a `session` path, a Google user's
 * POST, PUT, PATCH or DELETE passes only with `Origin` equal to the adapter's
 * `audience` and the session's CSRF value in `x-forit-csrf`
 * (`GOOGLE_CSRF_HEADER`); anything else gets 403 `CSRF_REJECTED` JSON. A
 * Next.js Server Action or a plain HTML form post cannot send that header, so
 * for a Google user it always gets that 403 (a Microsoft user's still works).
 * Make Google users' changes with `fetch` and the header. A path that must
 * take Server Actions or form posts has to stay off this middleware (a public
 * path, or outside the matcher), and then its page and handlers check the
 * session, and CSRF, themselves.
 *
 * Build the adapter with `createContainedGoogleSignIn` so that a refused
 * Google configuration closes Google (503 GOOGLE_SIGNIN_MISCONFIGURED) while
 * Microsoft sign-in keeps working.
 *
 * A route handler that also calls `requireGoogleSession` gets a new Request
 * object from Next.js, so it asks forit-Auth once more on the same page load.
 *
 * ```ts
 * // middleware.ts
 * import { createCombinedAuthMiddleware } from '@foritllc/auth';
 * import { auth } from './lib/auth-config';
 * import { google } from './lib/google'; // createContainedGoogleSignIn({ ... })
 * export default createCombinedAuthMiddleware(auth.config, google);
 * ```
 */
export function createCombinedAuthMiddleware(
  config: AuthConfig,
  google: CombinedGoogleSignIn
): (req: NextRequest) => Promise<NextResponse> {
  const microsoft = createAuthMiddleware(config);
  if (google.cookieName !== null && google.cookieName === config.cookieName) {
    console.error(
      '[forit/auth] combined middleware: the Google cookie has the Microsoft cookie\'s name, so Google is never read. Give the Microsoft cookie its own name.'
    );
  }
  const googleCookie = google.cookieName === config.cookieName ? null : google.cookieName;

  return async (request: NextRequest): Promise<NextResponse> => {
    if (
      googleCookie !== null &&
      !request.cookies.has(config.cookieName) &&
      request.cookies.has(googleCookie) &&
      routeAccess(config, request.nextUrl.pathname) === 'session'
    ) {
      const result = await google.requireGoogleSession(request);
      if (result.ok) return NextResponse.next();
      const headers = new Headers(result.response.headers);
      // Next.js cannot follow a path-only Location from middleware (a closed
      // adapter sends one), so it is resolved on the request's URL, which is
      // how createAuthMiddleware builds its own redirects.
      const location = headers.get('location');
      if (location !== null && location.startsWith('/') && !location.startsWith('//')) {
        headers.set('location', new URL(location, request.url).toString());
      }
      return new NextResponse(result.response.body, { status: result.response.status, headers });
    }
    const response = await microsoft(request);
    // Microsoft refuses a session or staff path whose Microsoft cookie does not
    // verify (an expired session, a rotated SESSION_SECRET, a same-named cookie
    // from a sibling host). Beside a Google cookie, that refusal also deletes
    // it, or a Google user would loop between sign-in and the page for as long
    // as the bad cookie lived. It is never read as Google, and this request is
    // still refused.
    if (googleCookie !== null && request.cookies.has(googleCookie) && request.cookies.has(config.cookieName)) {
      const access = routeAccess(config, request.nextUrl.pathname);
      if (
        (access === 'session' || access === 'staff') &&
        (await parseSessionCookie(request.cookies.get(config.cookieName)?.value)) === null
      ) {
        response.headers.append('Set-Cookie', deleteMicrosoftCookie(config, request));
      }
    }
    return response;
  };
}

/**
 * The Set-Cookie that deletes the Microsoft session cookie, built as the
 * logout route builds it (routes.ts): the Path, Secure and Domain it was
 * minted with. A same-named cookie that another host set under a different
 * Domain is out of its reach.
 */
function deleteMicrosoftCookie(config: AuthConfig, request: NextRequest): string {
  const baseUrl = typeof config.baseUrl === 'function' ? config.baseUrl(request) : config.baseUrl;
  const parts = [`${config.cookieName}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (baseUrl.startsWith('https://')) parts.push('Secure');
  if (config.cookieDomain) parts.push(`Domain=${config.cookieDomain}`);
  return parts.join('; ');
}
