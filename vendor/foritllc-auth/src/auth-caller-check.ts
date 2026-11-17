// metered-call-guard: not-metered — the hosts called are the host's own managed
// identity endpoint and forit-Auth (https://auth.forit.io), ForIT's own service.
// ============================================================================
// @foritllc/auth - Auth caller check (0.27.0)
// ============================================================================
//
// One question, asked of forit-Auth: is this app's managed identity the caller
// on the app's row? An app can ask before any sign-in provider is on, so the
// caller is proven without showing a sign-in button that cannot work yet
// (for-Presentation, Tasks 9FB901F2).
//
// The check gets a caller token the same way the Google adapter does, then
// POSTs a session handle it has just made up to the app's sessions/verify
// route. No session has that handle, so Auth's answer says only how far the
// call got (for-Auth, Tasks 9FB901F2, 2026-11-10):
//
// - 401 `invalid_session`: Auth accepted the identity and looked for the session.
// - 403: the identity is not the one on the app's row.
//
// It reads and changes nothing at Auth, and the answer holds no token, handle
// or body text.

import {
  AuthCallerTokenError,
  createAuthCallerTokenSource,
  type AuthCallerTokenErrorCode,
  type AuthCallerTokenSourceOptions,
} from './client-assertion.js';

/**
 * forit-Auth's origin and app id shape. The same values as `AUTH_ORIGIN` and
 * `APP_ID` in google-config.ts (a test holds them equal); they are repeated so
 * the root entry does not load the Google adapter's configuration.
 */
const AUTH_ORIGIN = 'https://auth.forit.io';
const APP_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DEFAULT_TIMEOUT_MS = 5000;

export interface AuthCallerCheckOptions extends AuthCallerTokenSourceOptions {
  /** The app's id on its forit-Auth row: the Google adapter's `appId`. */
  appId: string;
}

/**
 * - `accepted`: 401 `invalid_session`. Auth took the identity as the app's caller.
 * - `refused`: Auth answered and did not accept the call. 403 is an identity
 *   that is not the row's; any other status is given as it came.
 * - `unreachable`: no usable answer. `callerError` is set when there was no
 *   caller token and nothing was sent to Auth; otherwise it is a network
 *   error, a timeout, a redirect (`status` null) or a 5xx.
 */
export type AuthCallerCheck =
  | { outcome: 'accepted'; status: 401; callerError: null }
  | { outcome: 'refused'; status: number; callerError: null }
  | { outcome: 'unreachable'; status: number | null; callerError: AuthCallerTokenErrorCode | null };

/** 43 base64url characters from 32 random bytes: the shape of a session handle, and no session's handle. */
function madeUpSession(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Ask forit-Auth whether this app's managed identity is its caller. One token
 * request and one POST per call; nothing is cached and nothing is retried.
 *
 * `audience` and `clientId` are the app settings `AUTH_MI_AUDIENCE` and
 * `AUTH_MI_CLIENT_ID`, as for `getAuthCallerToken`. `timeoutMs` applies to the
 * token request and to the call to Auth, each on its own.
 *
 * Rejects with `AuthCallerTokenError` (`AUTH_CALLER_NOT_CONFIGURED`) when
 * `appId`, `audience`, `clientId` or `timeoutMs` fails its check; nothing is
 * sent. Every other result is returned.
 */
export async function checkAuthCaller(options: AuthCallerCheckOptions): Promise<AuthCallerCheck> {
  if (typeof options?.appId !== 'string' || !APP_ID.test(options.appId)) {
    throw new AuthCallerTokenError(
      'AUTH_CALLER_NOT_CONFIGURED',
      null,
      false,
      '[forit/auth] Auth caller check: appId is not a forit-Auth app id',
    );
  }
  // Checks audience, clientId and timeoutMs, and throws on a bad one.
  const token = createAuthCallerTokenSource(options);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let bearer: string;
  try {
    bearer = await token();
  } catch (error) {
    return {
      outcome: 'unreachable',
      status: null,
      callerError: error instanceof AuthCallerTokenError ? error.code : 'AUTH_CALLER_TOKEN_UNAVAILABLE',
    };
  }

  const unreachable = (status: number | null): AuthCallerCheck => ({ outcome: 'unreachable', status, callerError: null });
  let res: Response;
  try {
    res = await (options.fetch ?? fetch)(`${AUTH_ORIGIN}/api/v1/apps/${options.appId}/sessions/verify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ session: madeUpSession() }),
      // A redirect would carry the token somewhere else: refuse it.
      redirect: 'error',
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return unreachable(null);
  }
  if (res.status !== 401) {
    await res.body?.cancel().catch(() => undefined);
    return res.status >= 500 ? unreachable(res.status) : { outcome: 'refused', status: res.status, callerError: null };
  }
  let text: string;
  try {
    text = await res.text();
  } catch {
    // The status line came and the body did not: a timeout or a dropped connection.
    return unreachable(null);
  }
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const error = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { error?: unknown }).error : null;
  return error === 'invalid_session'
    ? { outcome: 'accepted', status: 401, callerError: null }
    : { outcome: 'refused', status: 401, callerError: null };
}
