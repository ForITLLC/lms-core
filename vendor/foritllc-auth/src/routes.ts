// metered-call-guard: not-metered — the only external host here is
// login.microsoftonline.com (Entra ID OAuth), which is free per request.
// ============================================================================
// @foritllc/auth - Route Handler Factories
// Returns Next.js route handlers for login, callback, logout, and me.
// ============================================================================

import { NextRequest, NextResponse } from 'next/server.js';
import { CLIENT_ASSERTION_TYPE } from './client-assertion.js';
import { FORIT_TENANT_ID } from './identity.js';
import { IdTokenError, validateIdToken } from './id-token.js';
import {
  TX_MAX_AGE_SECONDS,
  constantTimeEqual,
  newTransaction,
  openTransaction,
  sealTransaction,
  txCookieName,
  txSetCookie,
} from './oauth-transaction.js';
import { safeReturnTo } from './return-to.js';
import { assertSessionSecret, signSessionPayload } from './session-crypto.js';
import { parseSessionCookie } from './session-parse.js';
import type { AuthConfig, BaseSession, LoginPrompt } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  id_token: string;
  token_type: string;
  expires_in: number;
}

interface GraphUser {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
  /**
   * AAD account classification. `'Member'` for tenant members,
   * `'Guest'` for B2B guests invited from external tenants.
   * Some tenant configurations leave this null on guests, so the callback
   * also checks UPN for the `#EXT#@` suffix as a second signal.
   */
  userType?: 'Member' | 'Guest' | string | null;
}

function resolveMaxAge(config: AuthConfig): number {
  return config.sessionMaxAge ?? 28800; // 8 hours
}

function resolveDefaultReturnTo(config: AuthConfig): string {
  return safeReturnTo(config.defaultReturnTo ?? '/', '/');
}

function buildErrorUrl(config: AuthConfig, baseUrl: string, code: string): URL {
  const path = config.errorPath ?? '/';
  const url = new URL(path, baseUrl);
  url.searchParams.set('error', code);
  return url;
}

function resolveRedirectUri(config: AuthConfig, req: NextRequest): string {
  return typeof config.redirectUri === 'function'
    ? config.redirectUri(req)
    : config.redirectUri;
}

function resolveBaseUrl(config: AuthConfig, req: NextRequest): string {
  return typeof config.baseUrl === 'function'
    ? config.baseUrl(req)
    : config.baseUrl;
}

/**
 * The host the browser sent this request to, which is where the transaction
 * cookie lands. Behind App Service a standalone Next server builds
 * `request.url` from its own bind address (`0.0.0.0:8080`, a container name),
 * so the URL's host is not the browser's; the proxy's `X-Forwarded-Host`, then
 * `Host`, is. Only the login warning reads it: a forged header can silence or
 * raise a log line, nothing more.
 */
function browserHost(req: NextRequest, protocol: string): string {
  const raw =
    req.headers.get('x-forwarded-host')?.split(',')[0]?.trim() ||
    req.headers.get('host') ||
    new URL(req.url).host;
  // Through URL so `app.test:443` and `APP.test` compare equal to `app.test`.
  return new URL(`${protocol}//${raw}`).host;
}

function domainOf(address: string | null | undefined): string | null {
  const at = (address ?? '').lastIndexOf('@');
  return at > 0 ? address!.slice(at + 1).toLowerCase() : null;
}

/**
 * Pick the session email from a value the user's tenant cannot spoof.
 *
 * - Member: `mail` when its domain is a verified domain of the signed-in
 *   tenant (Graph `/organization`, readable with User.Read, whose id must
 *   equal the token's `tid`); otherwise the UPN, whose domain Entra only
 *   allows from the tenant's own verified domains. `emailVerified: true`.
 * - Guest (reachable only with `rejectGuests: false`): the resource tenant
 *   cannot vouch for a guest's home address, so `mail || UPN` as before
 *   with `emailVerified: false`. Never authorize on a guest's email.
 *
 * Fails closed: if `/organization` is unreadable or names another tenant,
 * a member gets the UPN.
 */
export async function resolveVerifiedEmail(
  user: Pick<GraphUser, 'mail' | 'userPrincipalName'>,
  isGuest: boolean,
  tid: string | undefined,
  accessToken: string,
): Promise<{ email: string; emailVerified: boolean }> {
  const upn = user.userPrincipalName;
  if (isGuest) return { email: user.mail || upn, emailVerified: false };
  const mailDomain = domainOf(user.mail);
  if (!user.mail || !mailDomain || mailDomain === domainOf(upn)) {
    return { email: user.mail || upn, emailVerified: true };
  }
  try {
    const res = await fetch(
      'https://graph.microsoft.com/v1.0/organization?$select=id,verifiedDomains',
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (res.ok) {
      const body = (await res.json()) as {
        value?: Array<{ id?: string; verifiedDomains?: Array<{ name?: string }> }>;
      };
      const org = body.value?.[0];
      const verified =
        !!tid &&
        org?.id === tid &&
        (org.verifiedDomains ?? []).some(
          (d) => typeof d.name === 'string' && d.name.toLowerCase() === mailDomain,
        );
      if (verified) return { email: user.mail, emailVerified: true };
    }
  } catch {
    // fall through — fail closed to the UPN
  }
  console.warn('[forit/auth] mail domain not verified in tenant; using UPN', {
    mailDomain,
    tid: tid ?? '(missing)',
  });
  return { email: upn, emailVerified: true };
}

function resolveTenantId(config: AuthConfig): string {
  return config.tenantId ?? FORIT_TENANT_ID;
}

const LOGIN_PROMPTS: readonly LoginPrompt[] = ['select_account', 'login', 'consent'];

function resolveLoginPrompt(config: AuthConfig): LoginPrompt | null {
  const prompt = config.loginPrompt ?? 'select_account';
  if (prompt === false) return null;
  if (!LOGIN_PROMPTS.includes(prompt)) {
    throw new TypeError(
      `[forit/auth] loginPrompt must be one of ${LOGIN_PROMPTS.join(', ')} or false; got ${JSON.stringify(prompt)}`,
    );
  }
  return prompt;
}

function resolveAllowedTenantIds(config: AuthConfig): string[] | null {
  if (config.allowedTenantIds === false) return null;
  return config.allowedTenantIds ?? [resolveTenantId(config)];
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

/**
 * Create a GET handler that redirects to Azure AD OAuth2 authorize endpoint.
 * Reads `returnTo` from query params (same-origin paths only, `safeReturnTo`).
 *
 * 0.8.0: also sets the sign-in transaction cookie (`<cookieName>_oauth`,
 * `__Host-` on HTTPS) holding the state nonce, the OIDC nonce and the PKCE
 * verifier; the callback refuses any code this browser did not ask for. The
 * callback must therefore run on the host that served this route (or one
 * covered by `cookieDomain`). It is also why every app signs in through this
 * handler and never through its own authorize URL: no cookie, no sign-in.
 *
 * 0.8.1: the Entra `prompt` is `config.loginPrompt` (default
 * `'select_account'`, `false` for none). An unknown value throws here, when
 * the route is built, not on a user's first sign-in.
 */
export function createLoginHandler(
  config: AuthConfig
): (req: NextRequest) => Promise<NextResponse> {
  assertSessionSecret();
  const prompt = resolveLoginPrompt(config);
  return async (request: NextRequest): Promise<NextResponse> => {
    const { searchParams } = new URL(request.url);
    const fallback = resolveDefaultReturnTo(config);
    const returnTo = safeReturnTo(searchParams.get('returnTo') || fallback, fallback);
    const baseUrl = resolveBaseUrl(config, request);
    const redirectUri = resolveRedirectUri(config, request);

    const { tx, codeChallenge } = await newTransaction();

    // State stays `base64(JSON {nonce, returnTo})` so app code that READS it
    // keeps working. Code that BUILDS it does not: the callback checks it
    // against the transaction cookie only this handler sets.
    const state = Buffer.from(
      JSON.stringify({
        nonce: tx.s,
        returnTo,
      })
    ).toString('base64');

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      response_mode: 'query',
      scope: 'openid profile email User.Read',
      state,
      nonce: tx.n,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });
    if (prompt) params.set('prompt', prompt);

    if (!config.cookieDomain) {
      try {
        const redirect = new URL(redirectUri);
        const host = browserHost(request, redirect.protocol);
        if (redirect.host !== host) {
          console.warn('[forit/auth] Login: redirectUri host differs from this host; the callback will not see the sign-in cookie', {
            redirectUri,
            host,
          });
        }
      } catch {
        // relative or malformed redirectUri — Entra will refuse it anyway
      }
    }

    const loginUrl = `https://login.microsoftonline.com/${resolveTenantId(config)}/oauth2/v2.0/authorize?${params.toString()}`;
    const response = NextResponse.redirect(loginUrl);
    response.headers.append(
      'Set-Cookie',
      txSetCookie(config, baseUrl, await sealTransaction(tx), TX_MAX_AGE_SECONDS),
    );
    return response;
  };
}

// ---------------------------------------------------------------------------
// Callback
// ---------------------------------------------------------------------------

/**
 * Create a GET handler that processes the Azure AD OAuth2 callback.
 * Exchanges code for tokens, fetches Graph /me, builds session, signs cookie.
 */
/**
 * The client credential the code redemption sends: a client assertion when
 * the app set `clientAssertion` (0.9.0+), the secret otherwise, exactly as
 * before. Setting both is a configuration error, refused when the handler is
 * created. A missing secret is not refused here, because `next build`
 * evaluates route modules without the app's settings; Entra refuses it at
 * redemption, as it always has.
 */
function clientCredential(config: AuthConfig): () => Promise<Record<string, string>> {
  const { clientAssertion, clientSecret } = config;
  if (clientAssertion !== undefined) {
    if (typeof clientAssertion !== 'function') {
      throw new Error('[forit/auth] clientAssertion must be a function returning the assertion JWT.');
    }
    if (clientSecret) {
      throw new Error(
        '[forit/auth] Both clientSecret and clientAssertion are set. An app holds one credential ' +
          '(forit-sign-in-client.md rule 3): drop the secret, or drop the assertion.'
      );
    }
    return async () => ({
      client_assertion_type: CLIENT_ASSERTION_TYPE,
      client_assertion: await clientAssertion(),
    });
  }
  return async () => ({ client_secret: clientSecret as string });
}

export function createCallbackHandler(
  config: AuthConfig
): (req: NextRequest) => Promise<Response> {
  assertSessionSecret();
  const credential = clientCredential(config);
  return async (request: NextRequest): Promise<Response> => {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const stateParam = searchParams.get('state');
    const error = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    const baseUrl = resolveBaseUrl(config, request);
    const redirectUri = resolveRedirectUri(config, request);

    // One sign-in per transaction: every answer from here on clears the
    // transaction cookie, success or not.
    const clearTx = txSetCookie(config, baseUrl, '', 0);
    const fail = (code: string): NextResponse => {
      const response = NextResponse.redirect(buildErrorUrl(config, baseUrl, code));
      response.headers.append('Set-Cookie', clearTx);
      return response;
    };

    // Handle errors from Azure AD
    if (error) {
      console.error('[forit/auth] Auth error:', error, errorDescription);
      return fail(errorDescription || error);
    }

    if (!code) {
      return fail('no_code');
    }

    // Validate state parameter (CSRF protection)
    if (!stateParam) {
      console.error('[forit/auth] Callback: missing state parameter');
      return fail('missing_state');
    }

    let state: { nonce?: unknown; returnTo?: unknown };
    try {
      state = JSON.parse(Buffer.from(stateParam, 'base64').toString());
      if (!state || typeof state !== 'object') throw new Error('not an object');
    } catch {
      console.error('[forit/auth] Callback: invalid state parameter');
      return fail('invalid_state');
    }

    // Login CSRF: the state must carry the nonce THIS browser's login stored.
    // Checked before the code is redeemed.
    const tx = await openTransaction(request.cookies.get(txCookieName(config, baseUrl))?.value);
    if (!tx || typeof state.nonce !== 'string' || !constantTimeEqual(state.nonce, tx.s)) {
      console.error('[forit/auth] Callback REJECTED: state does not match this browser\'s sign-in', {
        reason: tx ? 'nonce mismatch' : 'no valid sign-in cookie (expired, started on another host, or not started here)',
      });
      return fail('state_mismatch');
    }

    // The state is not signed, so its returnTo is re-checked here too.
    const fallbackReturnTo = resolveDefaultReturnTo(config);
    const returnTo = safeReturnTo(state.returnTo || fallbackReturnTo, fallbackReturnTo);

    try {
      // Exchange code for tokens
      const tokenResponse = await fetch(
        `https://login.microsoftonline.com/${resolveTenantId(config)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: config.clientId,
            ...(await credential()),
            code,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            scope: 'openid profile email User.Read',
            code_verifier: tx.v,
          }),
        }
      );

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.text();
        console.error('[forit/auth] Token exchange failed:', errorData);
        return fail('token_exchange_failed');
      }

      const tokens = (await tokenResponse.json()) as TokenResponse;

      // Tenancy is decided by `tid`, so `tid` comes from an id_token we
      // validated: signature against the tenant's keys, iss == .../<tid>/v2.0,
      // aud == our client, not expired, nonce == this browser's transaction.
      let tid: string;
      let iss: string;
      let loginHint: string | undefined;
      try {
        const claims = await validateIdToken(tokens.id_token, {
          clientId: config.clientId,
          nonce: tx.n,
        });
        tid = claims.tid;
        iss = claims.iss;
        // Optional claim: only there when the registration asks for it.
        if (typeof claims.login_hint === 'string' && claims.login_hint) {
          loginHint = claims.login_hint;
        }
      } catch (err) {
        console.error('[forit/auth] Callback REJECTED: id_token invalid', {
          reason: err instanceof IdTokenError ? err.reason : String(err),
          upstreamStatus: err instanceof IdTokenError ? err.upstreamStatus : undefined,
        });
        return fail('id_token_invalid');
      }

      // Get user info from Microsoft Graph. We $select explicitly so
      // `userType` is included — it's needed for the guest-rejection check
      // below and AAD doesn't return it from a bare /me call.
      const userResponse = await fetch(
        'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName,userType',
        { headers: { Authorization: `Bearer ${tokens.access_token}` } }
      );

      if (!userResponse.ok) {
        console.error('[forit/auth] Failed to get user info');
        return fail('user_info_failed');
      }

      const user = (await userResponse.json()) as GraphUser;
      const isGuest =
        user.userType === 'Guest' || /#EXT#@/i.test(user.userPrincipalName || '');

      // Security T-11 (nOAuth): `mail` is a free-text attribute any tenant
      // admin can set to any address, so `mail || userPrincipalName` let a
      // foreign tenant present `someone@example.com`. A UPN's domain must be
      // verified in the user's own tenant, so it cannot be spoofed across
      // tenants. `email` is therefore `mail` only when its domain is one of
      // the signed-in tenant's verified domains, else the UPN.
      const { email, emailVerified } = await resolveVerifiedEmail(
        user,
        isGuest,
        tid,
        tokens.access_token,
      );

      // Tenant-id allow-list. Default = the configured login tenant id.
      // Pass `allowedTenantIds: false` to opt out (cross-tenant apps).
      // Runs BEFORE onSessionCreated so the safe behavior is automatic — apps
      // do not have to remember to write the check themselves.
      const allowedTenants = resolveAllowedTenantIds(config);
      if (allowedTenants && !allowedTenants.some((t) => t.toLowerCase() === tid.toLowerCase())) {
        console.error('[forit/auth] Callback REJECTED: tenant not allowed', {
          email,
          tid,
          allowedTenants,
        });
        return fail('tenant_not_allowed');
      }

      // Guest rejection. Default ON — closes 2026-05-06 CRM B2B-guest
      // incident vector. Two-signal detection because some tenants leave
      // userType=null/Member on guests due to non-default config.
      const rejectGuests = config.rejectGuests ?? true;
      if (rejectGuests) {
        const isGuestByType = user.userType === 'Guest';
        if (isGuest) {
          console.error('[forit/auth] Callback REJECTED: guest account', {
            email,
            upn: user.userPrincipalName,
            userType: user.userType ?? '(null)',
            signal: isGuestByType ? 'userType' : 'upn-suffix',
          });
          return fail('guest_not_allowed');
        }
      }

      // Build base session
      const maxAgeSec = resolveMaxAge(config);
      const baseSession: BaseSession = {
        email,
        emailVerified,
        isGuest,
        name: user.displayName,
        azureOid: user.id,
        tid,
        iss,
        ...(loginHint ? { loginHint } : {}),
        expiresAt: Date.now() + maxAgeSec * 1000,
      };

      if (config.authorizeSession) {
        const decision = await config.authorizeSession(
          baseSession,
          tokens.access_token,
          request
        );
        const denied =
          decision === false ||
          (typeof decision === 'object' && decision !== null && decision.allowed === false);
        if (denied) {
          const rejectionCode =
            typeof decision === 'object' && decision !== null && decision.error
              ? decision.error
              : 'access_denied';
          console.error('[forit/auth] Callback REJECTED: app authorization failed', {
            email,
            tid,
            error: rejectionCode,
          });
          return fail(rejectionCode);
        }
      }

      // Call onSessionCreated hook if provided — lets the app add custom fields
      let extraFields: Record<string, unknown> = {};
      if (config.onSessionCreated) {
        extraFields = await config.onSessionCreated(
          baseSession,
          tokens.access_token,
          request,
          tokens.id_token
        );
      }

      // The app's extra fields cannot overwrite the validated identity.
      const sessionData = {
        ...baseSession,
        ...extraFields,
        tid: baseSession.tid,
        iss: baseSession.iss,
        azureOid: baseSession.azureOid,
        isGuest: baseSession.isGuest,
        emailVerified: baseSession.emailVerified,
        loginHint: baseSession.loginHint,
      };

      const base64Payload = Buffer.from(JSON.stringify(sessionData)).toString(
        'base64'
      );
      const cookieValue = await signSessionPayload(base64Payload);

      console.log('[forit/auth] Callback SUCCESS:', {
        email,
        redirectTo: returnTo,
      });

      // Build Set-Cookie header manually for maximum compatibility
      // (NextResponse.redirect + cookies.set has known issues)
      const cookieParts = [
        `${config.cookieName}=${cookieValue}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${maxAgeSec}`,
      ];
      if (baseUrl.startsWith('https://')) {
        cookieParts.push('Secure');
      }
      if (config.cookieDomain) {
        cookieParts.push(`Domain=${config.cookieDomain}`);
      }
      const setCookieHeader = cookieParts.join('; ');

      // safeReturnTo already pinned returnTo to a path; checking the resolved
      // origin as well keeps this a same-origin hop whatever baseUrl holds.
      let target = new URL(returnTo, baseUrl);
      if (target.origin !== new URL(baseUrl).origin) target = new URL('/', baseUrl);
      const fullRedirectUrl = target.toString();

      // Return HTML that sets cookie then redirects client-side.
      // Ensures cookie is properly stored before navigation. `<` is escaped
      // so no value can close the <script> element.
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Signing in...</title>
</head>
<body>
  <p>Signing you in...</p>
  <script>
    setTimeout(function() {
      window.location.href = ${JSON.stringify(fullRedirectUrl).replace(/</g, '\\u003c')};
    }, 500);
  </script>
</body>
</html>`;

      const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      headers.append('Set-Cookie', setCookieHeader);
      headers.append('Set-Cookie', clearTx);
      return new Response(html, { status: 200, headers });
    } catch (err) {
      console.error('[forit/auth] Callback error:', err);
      return fail('callback_failed');
    }
  };
}

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

/**
 * Create a logout handler safe to export as BOTH `GET` and `POST`.
 *
 * CSRF defense (2026-07-02 for-AVHR gap report): a plain GET logout is
 * triggerable cross-site — `<img src=/api/auth/logout>`, a hidden iframe, or
 * link prefetch silently signs users out. Requests carrying
 * `Sec-Fetch-Site: cross-site` (sent by every evergreen browser on
 * cross-site subresources, navigations, and form posts) are rejected 403
 * with the cookie untouched. Requests without the header (curl, pre-2023
 * Safari) fail open by design — the residual exposure is only browsers too
 * old to send fetch metadata.
 *
 * Wire it as:
 *   export const POST = auth.routes.logout;  // golden standard: form/fetch POST
 *   export const GET = auth.routes.logout;   // keeps existing logout links working
 *
 * Success clears the cookie and 303s — 303 so a POST logout redirects as GET
 * instead of re-POSTing the target. From 0.11.0 a browser sign-out on this
 * origin (a form POST or a link: `Sec-Fetch-Mode: navigate` with
 * `Sec-Fetch-Site` same-origin or none; with no fetch metadata, `Accept:
 * text/html`) 303s to Entra's end-session endpoint, with
 * `post_logout_redirect_uri` set to `https://<host>/` and `logout_hint` from
 * the session's `loginHint` when it has one, so the Microsoft session ends too
 * (B30FB47C: on a shared PC the next person otherwise finds the last user one
 * click away). A `fetch()` or XHR logout can't follow a cross-origin
 * redirect, and a same-site page must not end the Microsoft session, so both
 * still get `/`. `endEntraSession: false` keeps `/` for every request. A
 * Next.js prefetch or `<Link>` soft navigation gets 204 with the cookie
 * untouched, and Next follows it with a real navigation.
 */
export function createLogoutHandler(
  config: AuthConfig
): (req: NextRequest) => Promise<NextResponse> {
  return async (request: NextRequest): Promise<NextResponse> => {
    if (request.headers.get('sec-fetch-site') === 'cross-site') {
      return NextResponse.json(
        { error: 'Cross-site logout blocked', code: 'CSRF_REJECTED' },
        { status: 403 }
      );
    }

    // A Next.js prefetch must not sign anyone out, and a <Link> soft
    // navigation can't follow a redirect to Entra: 204 with the cookie
    // untouched, which Next answers with a real navigation to this route.
    if (isNextRouterFetch(request)) {
      return new NextResponse(null, { status: 204 });
    }

    const baseUrl = resolveBaseUrl(config, request);

    // Deletion Set-Cookie built manually, mirroring the callback's mint.
    // Delete must specify the same Domain that mint used, otherwise the
    // browser keeps the parent-domain cookie alive on host-only delete.
    const cookieParts = [
      `${config.cookieName}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=0',
    ];
    if (baseUrl.startsWith('https://')) {
      cookieParts.push('Secure');
    }
    if (config.cookieDomain) {
      cookieParts.push(`Domain=${config.cookieDomain}`);
    }

    const home = new URL('/', baseUrl);
    const response = NextResponse.redirect(
      await logoutTarget(config, request, home),
      303
    );
    response.headers.set('Set-Cookie', cookieParts.join('; '));
    return response;
  };
}

async function logoutTarget(
  config: AuthConfig,
  request: NextRequest,
  home: URL
): Promise<URL> {
  if (config.endEntraSession === false) return home;
  // Entra only for the user's own navigation on this origin. A sibling site
  // (same-site) may sign the user out of this app, never out of Microsoft.
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return home;
  // Only a top-level navigation can follow a redirect to Entra; a fetch()
  // would fail CORS on login.microsoftonline.com. With no fetch metadata
  // (curl, old Safari), only a request that asks for a page counts.
  const mode = request.headers.get('sec-fetch-mode');
  const navigation = mode
    ? mode === 'navigate'
    : (request.headers.get('accept') ?? '').includes('text/html');
  if (!navigation) return home;

  const url = new URL(
    `https://login.microsoftonline.com/${resolveTenantId(config)}/oauth2/v2.0/logout`
  );
  url.searchParams.set('post_logout_redirect_uri', home.toString());
  const session = await parseSessionCookie(
    request.cookies.get(config.cookieName)?.value
  );
  if (typeof session?.loginHint === 'string' && session.loginHint) {
    url.searchParams.set('logout_hint', session.loginHint);
  }
  return url;
}

/** Next.js router fetches: a prefetch, or a <Link> soft navigation (RSC). */
function isNextRouterFetch(request: NextRequest): boolean {
  const h = request.headers;
  return (
    h.get('next-router-prefetch') === '1' ||
    h.get('purpose') === 'prefetch' ||
    (h.get('sec-purpose') ?? '').includes('prefetch') ||
    h.get('x-middleware-prefetch') === '1' ||
    h.has('rsc') ||
    request.nextUrl.searchParams.has('_rsc')
  );
}

// ---------------------------------------------------------------------------
// Me
// ---------------------------------------------------------------------------

/**
 * Create a GET handler that returns the current session as JSON (or 401).
 */
export function createMeHandler(
  config: AuthConfig
): (req: NextRequest) => Promise<NextResponse> {
  assertSessionSecret();
  return async (request: NextRequest): Promise<NextResponse> => {
    const sessionCookie = request.cookies.get(config.cookieName);
    const session = await parseSessionCookie(sessionCookie?.value);

    if (!session) {
      return NextResponse.json(
        { error: 'Not authenticated', code: 'UNAUTHENTICATED' },
        { status: 401 }
      );
    }

    return NextResponse.json(session);
  };
}
