// ============================================================================
// @foritllc/auth - High-level Mode Factories
//
// Two explicit factories replace the three-coordinated-flag footgun in the
// raw AuthConfig API:
//
//   createForitAuth()         — single-tenant, ForIT-only. Safe defaults baked
//                               in: pinned to the ForIT AAD tenant, guests
//                               rejected. Consumer makes zero security
//                               decisions about tenancy. Use for: Support, HR,
//                               Manuals, Budgets, IssueLog, Forms (the
//                               internal-only ones), Travel, CRM, and any
//                               other ForIT-staff-only app.
//
//   createMultiTenantAuth()   — accepts logins from foreign AAD tenants.
//                               `allowedTenantIds` is REQUIRED (no default):
//                               either `false` (any AAD tenant — you MUST gate
//                               inside onSessionCreated, e.g. via a DB lookup,
//                               LMS-style) or `string[]` (explicit allow-list,
//                               AviationManagement-style). Guests rejected by
//                               default; flip `acceptGuests: true` to allow.
//                               Use for: LMS, AviationManagement/AvOps, and
//                               any future customer-facing AAD-login app.
//
// Both factories wrap the same underlying createAuthMiddleware /
// createLoginHandler / createCallbackHandler / createLogoutHandler /
// createMeHandler primitives. The factories' job is to force mode-specific
// security decisions to be made explicitly, and to bundle the five handlers
// into one object so callers don't have to import five names and wire them.
//
// The raw AuthConfig API stays exported for back-compat. New apps should
// reach for these factories first.
// ============================================================================

import type { NextRequest, NextResponse } from 'next/server.js';
import { createAuthMiddleware } from './middleware.js';
import {
  createCallbackHandler,
  createLoginHandler,
  createLogoutHandler,
  createMeHandler,
} from './routes.js';
import { FORIT_TENANT_ID } from './identity.js';
import type { AuthConfig } from './types.js';

/** The ForIT corporate AAD tenant id. */
export { FORIT_TENANT_ID };

// ---------------------------------------------------------------------------
// Shared shape — fields common to both modes
// ---------------------------------------------------------------------------

interface CommonConfig {
  /** Azure AD application (client) ID. */
  clientId: string;
  /** Azure AD client secret. Optional from 0.9.0; see `AuthConfig.clientSecret`. */
  clientSecret?: string;
  /**
   * 0.9.0+: a client assertion instead of a secret, e.g.
   * `managedIdentityClientAssertion()`. See `AuthConfig.clientAssertion`.
   */
  clientAssertion?: AuthConfig['clientAssertion'];
  /** OAuth2 redirect URI — static string or function deriving from request. */
  redirectUri: string | ((req: NextRequest) => string);
  /** Base URL of the app — static string or function deriving from request. */
  baseUrl: string | ((req: NextRequest) => string);
  /** Cookie name (e.g. `'forit_lms_session'`). */
  cookieName: string;
  /**
   * Cookie `Domain` attribute. Omit for host-only (safest). Set to a
   * registrable parent (e.g. `.lms.forit.io`) when the app spans multiple
   * subdomains and a single sign-in must cover all of them.
   */
  cookieDomain?: string;
  /** Session max age in seconds. Default: 28800 (8h). */
  sessionMaxAge?: number;
  /**
   * 0.10.0+: every path needs a session unless it is a static asset or on
   * `publicPaths`. Default `false`; `true` from 1.0.0. See `AuthConfig.defaultDeny`.
   */
  defaultDeny?: boolean;
  /** Paths that require authentication (prefix match). Ignored under `defaultDeny`. */
  protectedPaths?: string[];
  /**
   * Paths that never require auth. Default: `['/', '/api/auth']`; setting it
   * replaces the default, so list both yourself. See `AuthConfig.publicPaths`.
   */
  publicPaths?: string[];
  /**
   * 0.8.0+: paths only ForIT staff may reach (ForIT tenant by validated
   * `tid`, never email). Implies protected. See `AuthConfig.staffPaths`.
   */
  staffPaths?: string[];
  /** Default redirect after login when no `returnTo` is provided. Default: `'/'`. */
  defaultReturnTo?: string;
  /**
   * 0.8.1+: the Entra `prompt` `routes.login` sends. Default
   * `'select_account'`; `false` sends none. See `AuthConfig.loginPrompt`.
   */
  loginPrompt?: AuthConfig['loginPrompt'];
  /**
   * 0.11.0+: whether `routes.logout` also ends the Microsoft session.
   * Default `true`. See `AuthConfig.endEntraSession`.
   */
  endEntraSession?: AuthConfig['endEntraSession'];
  /** Path that receives `?error=...` redirects. Default: `/`. */
  errorPath?: string;
  /**
   * Refuse a sign-in after the tenant/guest checks and before the cookie is
   * minted. Return `false` or `{ allowed: false, error: 'code' }`. (Typed on
   * the factories from 0.8.0; the runtime always passed it through.)
   */
  authorizeSession?: AuthConfig['authorizeSession'];
  /**
   * Hook called after Graph /me is fetched during callback AND after the
   * built-in tenant + guest checks pass. Return extra fields to merge into
   * the session cookie payload.
   *
   * In multi-tenant mode this is where you typically resolve the user's
   * app-level tenant — e.g. look up `session.tid` in your `Tenant` table,
   * upsert an `AppUser` row, and return `{ tenantId, role }`.
   *
   * The live callback `NextRequest` is passed third so host-dependent logic
   * (e.g. hostname→tenant narrowing on white-label multi-host apps) doesn't
   * need to reach for `next/headers`. The fourth argument is the original
   * validated Entra ID token, for server-side signed-author forwarding. It is
   * not automatically persisted in the session. Earlier callbacks remain valid.
   */
  onSessionCreated?: AuthConfig['onSessionCreated'];
}

// ---------------------------------------------------------------------------
// Mode A — ForIT-only (single-tenant)
// ---------------------------------------------------------------------------

/**
 * Config for `createForitAuth`. No tenancy knobs — they're pinned to safe
 * ForIT-only defaults (tenant id = FORIT_TENANT_ID, allow-list = [that],
 * guests rejected).
 */
export type ForitAuthConfig = CommonConfig;

// ---------------------------------------------------------------------------
// Mode B — multi-tenant
// ---------------------------------------------------------------------------

export interface MultiTenantAuthConfig extends CommonConfig {
  /**
   * Which AAD tenants are permitted to complete login. **Required — no
   * default.** Make this choice explicitly:
   *
   *   - `false` — accept ANY AAD tenant. The package will not gate by `tid`;
   *     you MUST gate inside `onSessionCreated` (typically: look up
   *     `session.tid` in your tenants table; if missing, reject or mint an
   *     unbound session). This is the forit-LMS pattern.
   *
   *   - `string[]` — explicit allow-list of tenant ids. The callback rejects
   *     with 403 if the id_token's `tid` isn't in the list. This is the
   *     forit-AviationManagement pattern (env-var-driven allow-list).
   *
   * Picking the right one is the most important security decision in this
   * config — that's why there's no default.
   */
  allowedTenantIds: false | string[];
  /**
   * Whether to accept B2B guest accounts. Default: `false` (reject). Set
   * `true` only for apps that intentionally invite cross-tenant guests.
   *
   * Rejection uses two signals from Graph /me: `userType === 'Guest'` AND
   * UPN containing `#EXT#@` (belt-and-suspenders — catches tenants where
   * guests have `userType=Member` due to non-default configuration).
   */
  acceptGuests?: boolean;
  /**
   * Microsoft authority endpoint. Default: `'organizations'` (any AAD
   * tenant; rejects personal MSAs). Use `'common'` only if you also want to
   * accept personal Microsoft accounts — rare for B2B apps.
   */
  authority?: 'organizations' | 'common';
}

// ---------------------------------------------------------------------------
// Returned bundle
// ---------------------------------------------------------------------------

/**
 * Auth handlers bundled into one object — `middleware` for middleware.ts,
 * `routes.login` / `routes.callback` / `routes.logout` / `routes.me` for the
 * `/api/auth/[action]/route.ts` files.
 */
export interface AuthHandlers {
  middleware: (req: NextRequest) => Promise<NextResponse>;
  routes: {
    login: (req: NextRequest) => Promise<NextResponse>;
    callback: (req: NextRequest) => Promise<Response>;
    logout: (req: NextRequest) => Promise<NextResponse>;
    me: (req: NextRequest) => Promise<NextResponse>;
  };
  /**
   * The fully-resolved underlying AuthConfig. Exposed so apps that need a
   * raw primitive (e.g. `createGetSession(config)`) can grab it without
   * re-deriving the values the factory baked in.
   */
  config: AuthConfig;
}

// ---------------------------------------------------------------------------
// Factory bodies
// ---------------------------------------------------------------------------

function buildHandlers(config: AuthConfig): AuthHandlers {
  return {
    middleware: createAuthMiddleware(config),
    routes: {
      login: createLoginHandler(config),
      callback: createCallbackHandler(config),
      logout: createLogoutHandler(config),
      me: createMeHandler(config),
    },
    config,
  };
}

/**
 * Single-tenant ForIT-only auth. Tenancy is pinned to the ForIT corporate
 * AAD tenant; guests are rejected. Consumer makes no security decisions about
 * tenancy.
 *
 * @example
 * ```ts
 * // lib/auth-config.ts
 * import { createForitAuth } from '@foritllc/auth';
 *
 * export const auth = createForitAuth({
 *   clientId: process.env.AZURE_AD_CLIENT_ID!,
 *   clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
 *   // or no secret at all (0.9.0+), the app's managed identity through a
 *   // federated credential: clientAssertion: managedIdentityClientAssertion(),
 *   redirectUri: process.env.AZURE_AD_REDIRECT_URI!,
 *   baseUrl: process.env.NEXT_PUBLIC_APP_URL!,
 *   cookieName: 'forit_support_session',
 *   defaultDeny: true, // 0.10.0+: every path not on publicPaths needs a session
 * });
 *
 * // middleware.ts
 * export const middleware = auth.middleware;
 *
 * // app/api/auth/login/route.ts
 * export const GET = auth.routes.login;
 * ```
 */
export function createForitAuth(config: ForitAuthConfig): AuthHandlers {
  const fullConfig: AuthConfig = {
    ...config,
    tenantId: FORIT_TENANT_ID,
    allowedTenantIds: [FORIT_TENANT_ID],
    rejectGuests: true,
  };
  return buildHandlers(fullConfig);
}

/**
 * Multi-tenant AAD auth. Use when end-users from foreign AAD tenants log in
 * to the app (LMS, AviationManagement, future customer-facing AAD-login apps).
 *
 * `allowedTenantIds` is required — there is no safe default for "which
 * customer tenants are allowed in." Pick:
 *
 *   - `false` to accept any AAD tenant (gate inside `onSessionCreated` via a
 *     DB lookup — LMS pattern), or
 *   - `string[]` for an explicit allow-list (AviationManagement pattern).
 *
 * `acceptGuests` defaults to `false` (safe). `authority` defaults to
 * `'organizations'` (no personal MSAs).
 *
 * @example
 * ```ts
 * // LMS-style (any AAD tenant, DB gate in hook)
 * import { createMultiTenantAuth } from '@foritllc/auth';
 *
 * export const auth = createMultiTenantAuth({
 *   clientId: process.env.AZURE_AD_CLIENT_ID!,
 *   clientSecret: process.env.AZURE_AD_CLIENT_SECRET!,
 *   redirectUri: process.env.AZURE_AD_REDIRECT_URI!,
 *   baseUrl: process.env.NEXT_PUBLIC_APP_URL!,
 *   cookieName: 'forit_lms_session',
 *   cookieDomain: '.lms.forit.io',
 *   defaultDeny: true,
 *   allowedTenantIds: false,
 *   onSessionCreated: async (session) => {
 *     const tenant = await resolveTenantForAadTid(session.tid);
 *     if (!tenant) return {}; // unbound session, app routes handle the deny
 *     await upsertAppUser(session.email, tenant.id);
 *     return { tenantId: tenant.id, role: 'learner' };
 *   },
 * });
 *
 * // AviationManagement-style (explicit allow-list from env)
 * export const auth = createMultiTenantAuth({
 *   ...common,
 *   allowedTenantIds: process.env.ALLOWED_TENANT_IDS!.split(','),
 * });
 * ```
 */
export function createMultiTenantAuth(
  config: MultiTenantAuthConfig
): AuthHandlers {
  const fullConfig: AuthConfig = {
    ...config,
    tenantId: config.authority ?? 'organizations',
    allowedTenantIds: config.allowedTenantIds,
    rejectGuests: !(config.acceptGuests ?? false),
  };
  return buildHandlers(fullConfig);
}
