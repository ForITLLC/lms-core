// ============================================================================
// @foritllc/auth - Type Definitions
// ============================================================================

import type { NextRequest } from 'next/server.js';

/**
 * The Entra `prompt` values a login route may send. `'none'` is not one: it
 * fails with `login_required` for anyone not already signed in, which turns
 * the login route into an error page.
 */
export type LoginPrompt = 'select_account' | 'login' | 'consent';

/**
 * Configuration for the auth system.
 * Each consuming app creates one of these and passes it to the factory functions.
 */
export interface AuthConfig {
  /** Azure AD application (client) ID */
  clientId: string;
  /**
   * Azure AD client secret. 0.9.0+: optional, because an app may hold a
   * `clientAssertion` instead. Set one of the two, never both: the callback
   * handler throws when it is created with a non-empty secret AND an
   * assertion.
   */
  clientSecret?: string;
  /**
   * 0.9.0+: redeem the code with a client assertion instead of a secret
   * (`client_assertion_type` jwt-bearer). Called on every callback; return a
   * JWT Entra accepts for this client. For a federated credential that trusts
   * the app's own managed identity, use `managedIdentityClientAssertion()`.
   * A throw here fails the sign-in (`callback_failed`); nothing falls back to
   * a secret.
   */
  clientAssertion?: () => Promise<string>;
  /**
   * Azure AD tenant id used in the OAuth2 authorize + token endpoints.
   * Default: `'c0efa09e-4bda-4a9d-a177-4c77076b7f76'` (the ForIT tenant).
   *
   * Pre-0.3.0 the package hardcoded `'common'` here, which accepted any
   * Microsoft tenant on the planet. Apps that genuinely want cross-tenant
   * login (white-label customer apps) must opt in by passing `'common'` or
   * `'organizations'` and pair it with `allowedTenantIds: false` (or an
   * explicit allow-list).
   */
  tenantId?: string;
  /**
   * Tenant ids permitted to complete login. The callback inspects the
   * id_token's `tid` claim and rejects with 403 if it isn't in this list.
   *
   * Default: `[tenantId]` (i.e. only the configured login tenant). Pass
   * `false` to skip the check (only valid when `tenantId` is `'common'` or
   * `'organizations'` AND the app intentionally accepts cross-tenant users).
   *
   * This runs BEFORE `onSessionCreated` so the safe behavior is automatic;
   * apps don't have to remember to write the check themselves.
   */
  allowedTenantIds?: string[] | false;
  /**
   * Reject B2B guest accounts at the callback. Default: `true`.
   *
   * Guest detection uses two signals from Graph /me:
   *   1. `userType === 'Guest'` (the canonical AAD signal)
   *   2. UPN containing `#EXT#@` (belt-and-suspenders — covers tenants
   *      where guests have userType=Member due to non-default configuration)
   *
   * Set to `false` only for apps that intentionally invite cross-tenant
   * guests (e.g. customer-facing share flows that authenticate via
   * `@foritllc/external-auth` should never use this path at all; if they do
   * use this package, they accept guests by setting `rejectGuests: false`).
   *
   * Rationale: closes the 2026-05-06 CRM B2B-guest pipeline-data incident —
   * a single tenant accidentally added forit.io users as Guest, and the CRM
   * accepted those sessions because tid matched and there was no guest gate.
   *
   * Runs AFTER `allowedTenantIds` and BEFORE `onSessionCreated`.
   */
  rejectGuests?: boolean;
  /** OAuth2 redirect URI — static string or function deriving from request */
  redirectUri: string | ((req: NextRequest) => string);
  /** Base URL of the app — static string or function deriving from request */
  baseUrl: string | ((req: NextRequest) => string);
  /** Cookie name (e.g. 'forit_budgets_session') */
  cookieName: string;
  /**
   * Cookie `Domain` attribute. Omit for a host-only cookie (the default and
   * safest choice). Set to a registrable parent (e.g. `.lms.forit.io`) when
   * the app spans multiple subdomains and a single sign-in must cover all of
   * them — otherwise each subdomain hop re-prompts the user. Leading dot is
   * optional; modern browsers ignore it. Logout uses the same Domain so the
   * deleted cookie matches the one that was set.
   */
  cookieDomain?: string;
  /** Session max age in seconds. Default: 28800 (8 hours) */
  sessionMaxAge?: number;
  /**
   * 0.10.0+: every path needs a session unless it is a static asset
   * (`/_next/*`, `/static/*`, `/favicon*.ico|png|svg`) or on `publicPaths`.
   * Default `false` (allow-by-default: only `protectedPaths` are checked);
   * the default becomes `true` in 1.0.0 (forit-Common#284). With it set,
   * `protectedPaths` is ignored, and the middleware throws at startup if
   * `/`, `/api/auth` or a custom `errorPath` would need a session.
   */
  defaultDeny?: boolean;
  /**
   * Paths that require authentication (prefix match on a path boundary).
   * Ignored under `defaultDeny`, which protects everything not public.
   */
  protectedPaths?: string[];
  /**
   * Paths that never require auth (prefix match on a path boundary).
   * Default: `['/', '/api/auth']`. Setting it REPLACES the default, so list
   * `'/'` and `'/api/auth'` yourself. Under `defaultDeny` this is the only
   * opt-out: health checks, keyed machine routes and pages meant for the
   * world go here.
   */
  publicPaths?: string[];
  /**
   * 0.8.0+: paths (prefix match) that only ForIT staff may reach — a session
   * from the ForIT tenant, by the validated `tid` (`isForitStaffSession`),
   * never by email. Implies protected. Others get 403 on `/api/*` and a
   * redirect to `errorPath?error=staff_only` on pages. Use it in multi-tenant
   * apps for the admin/authoring surface, e.g. `['/admin', '/api/admin']`.
   */
  staffPaths?: string[];
  /**
   * Default redirect after login when no (valid) returnTo is given. Default:
   * '/'. Must itself be a same-origin path (see `safeReturnTo`), else '/'.
   */
  defaultReturnTo?: string;
  /**
   * 0.8.1+. The `prompt` the login route sends to Entra. Default:
   * `'select_account'` (the account picker on every sign-in). `false` sends
   * no prompt, so a user already signed in to Microsoft goes straight
   * through; `'login'` forces a password; `'consent'` forces the consent
   * screen. Set it here, never by wrapping or forking the login route: a
   * route that builds its own authorize URL sets no transaction cookie, and
   * every callback after it fails `state_mismatch`.
   */
  loginPrompt?: LoginPrompt | false;
  /**
   * 0.11.0+. Whether `routes.logout` also ends the user's Microsoft session.
   * Default `true`: a browser sign-out (a form POST or a link) clears the
   * app cookie and 303s to Entra's end-session endpoint, which signs the
   * account out and returns to `https://<host>/`. Without it the next person
   * on a shared PC finds the last user still "Signed in" on Microsoft's
   * account picker. Entra returns only to a URI on the registration, so
   * enrol `https://<host>/` beside the callback; until then the user stays
   * on Microsoft's "You signed out" page. `false` keeps the 0.10 behaviour
   * (cookie only, 303 to `/`).
   */
  endEntraSession?: boolean;
  /** Path that receives `?error=...` redirects. Default: `/`. */
  errorPath?: string;
  /**
   * Hook called after Microsoft tenant/guest checks and before session cookie
   * creation. Return `{ allowed: false, error: 'code' }` to reject without
   * minting a cookie.
   */
  authorizeSession?: (
    session: BaseSession,
    graphAccessToken: string,
    request: NextRequest
  ) => Promise<void | boolean | { allowed?: boolean; error?: string }>;
  /**
   * Hook called after Graph /me is fetched during callback AND after the
   * built-in `allowedTenantIds` check passes. Return extra fields to merge
   * into the session cookie payload.
   *
   * The live callback `NextRequest` is passed third so host-dependent logic
   * (e.g. hostname→tenant narrowing on white-label multi-host apps) doesn't
   * need to reach for `next/headers`. The fourth argument is the original
   * validated Entra ID token, for server-side signed-author forwarding. It is
   * not automatically persisted in the session. Earlier callbacks remain valid.
   */
  onSessionCreated?: (
    session: BaseSession,
    graphAccessToken: string,
    request: NextRequest,
    idToken: string
  ) => Promise<Record<string, unknown>>;
}

/**
 * Base session payload stored in the HMAC-signed cookie.
 * Apps can add custom fields via onSessionCreated.
 */
export interface BaseSession {
  /**
   * User's email address from Graph /me. From 0.7.0 this is `mail` only when
   * its domain is verified in the signed-in tenant, otherwise the UPN — a
   * foreign tenant can no longer present another tenant's address here.
   * Still a label: authorize on `tid` + `azureOid` (see `isForitStaffSession`,
   * `sessionInTenant`, `sessionPrincipalKey`), not on the email's domain.
   */
  email: string;
  /**
   * 0.7.0+: true when `email` came from a domain the user's own tenant has
   * verified (always false for guests). Absent on older sessions — treat as
   * false. Read it through `verifiedSessionEmail()`.
   */
  emailVerified?: boolean;
  /** 0.7.0+: the account is a B2B guest (only possible with `rejectGuests: false`). */
  isGuest?: boolean;
  /** User's display name from Graph /me */
  name: string;
  /** Azure AD object ID */
  azureOid: string;
  /**
   * Azure AD tenant id (`tid` claim) from the id_token. 0.8.0+: the callback
   * only mints a session from an id_token it validated (signature, issuer,
   * audience, expiry, nonce), so `tid` is always present on a live session.
   */
  tid?: string;
  /**
   * 0.8.0+: the validated id_token's issuer,
   * `https://login.microsoftonline.com/<tid>/v2.0`. Its presence (matching
   * `tid`) is what marks the `tid` as validated; sessions without it are
   * rejected by every reader. See `sessionTenantValidated`.
   */
  iss?: string;
  /**
   * 0.11.0+: the validated id_token's `login_hint` claim, an opaque value
   * Entra emits only when the registration lists it as an optional id-token
   * claim. `routes.logout` sends it as `logout_hint` so Microsoft signs this
   * account out without asking which one. Absent when not emitted.
   */
  loginHint?: string;
  /** Cookie expiry timestamp (ms since epoch) */
  expiresAt: number;
  /** Allow custom fields added by onSessionCreated */
  [key: string]: unknown;
}
