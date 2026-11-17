// ============================================================================
// @foritllc/auth - Barrel Export
// MSAL-based authentication for ForIT Next.js apps.
// ============================================================================

// Types
export type { AuthConfig, BaseSession, LoginPrompt } from './types.js';

// High-level mode factories (RECOMMENDED for new apps — they enforce
// mode-specific security decisions explicitly).
export {
  createForitAuth,
  createMultiTenantAuth,
  FORIT_TENANT_ID,
} from './factories.js';
export type {
  AuthHandlers,
  ForitAuthConfig,
  MultiTenantAuthConfig,
} from './factories.js';

// Session crypto (HMAC-SHA256 sign/verify)
export {
  signSessionPayload,
  verifySessionPayload,
  assertSessionSecret,
  sessionSecretProblem,
} from './session-crypto.js';

// Raw route handler factories (kept for back-compat; prefer createForitAuth /
// createMultiTenantAuth above for new code).
export {
  createLoginHandler,
  createCallbackHandler,
  createLogoutHandler,
  createMeHandler,
} from './routes.js';

// Raw middleware factory (kept for back-compat; prefer createForitAuth /
// createMultiTenantAuth above for new code).
export { createAuthMiddleware, routeAccess, DEFAULT_PUBLIC_PATHS } from './middleware.js';
export type { RouteAccess } from './middleware.js';

// 0.14.0: opt-in Microsoft + Google middleware. Microsoft still goes through
// createAuthMiddleware unchanged; a request with only a Google cookie on a
// session path asks the Google adapter (from `@foritllc/auth/google`).
export { createCombinedAuthMiddleware } from './combined-middleware.js';
export type { CombinedGoogleSignIn } from './combined-middleware.js';

// Tenant-bound identity (Security T-11): authorize on tid + oid, never on an
// email domain.
export {
  sessionPrincipalKey,
  sessionInTenant,
  sessionTenantValidated,
  isForitStaffSession,
  verifiedSessionEmail,
  entraIssuer,
} from './identity.js';
export { resolveVerifiedEmail } from './routes.js';

// 0.8.0: id_token validation, the one session-cookie reader, and the
// same-origin redirect guard — exported for apps with their own routes.
export { validateIdToken, IdTokenError } from './id-token.js';
export type { ValidatedIdToken } from './id-token.js';
export { parseSessionCookie } from './session-parse.js';
export { safeReturnTo } from './return-to.js';

// 0.9.0: sign in with no secret, through a federated credential that trusts
// the app's managed identity (forit-sign-in-client.md rule 3).
export {
  managedIdentityClientAssertion,
  ManagedIdentityTokenError,
  CLIENT_ASSERTION_TYPE,
  TOKEN_EXCHANGE_AUDIENCE,
} from './client-assertion.js';
export type { ManagedIdentityAssertionOptions } from './client-assertion.js';

// 0.18.0: an app's server proves itself to forit-Auth's session routes with a
// managed identity token in place of a fau_ key (for-Auth's caller contract).
export { getAuthCallerToken, createAuthCallerTokenSource, AuthCallerTokenError } from './client-assertion.js';
export type {
  AuthCallerTokenOptions,
  AuthCallerTokenSourceOptions,
  AuthCallerTokenErrorCode,
} from './client-assertion.js';

// 0.27.0: asks forit-Auth whether this app's managed identity is the caller
// on its row, before any sign-in provider is on (Tasks 9FB901F2).
export { checkAuthCaller } from './auth-caller-check.js';
export type { AuthCallerCheck, AuthCallerCheckOptions } from './auth-caller-check.js';

// 0.25.0: the receiver for another app's managed identity token
// (createWorkloadTokenVerifier, parseWorkloadTokenPolicy,
// bearerFromAuthorization and their types) is on `@foritllc/auth/workload`
// only. This entry is what a Next.js middleware imports, and the receiver is
// the one file that loads jose, so re-exporting it here put jose in every
// Edge middleware bundle (for-sms, 2026-11-09, Agile A53CD5B3).

// Server-side session helper
export { createGetSession } from './get-session.js';

// Tenant resolution helper — bridges auth → @foritllc/tenant-theme
export { createGetTenantContext } from './tenant-context.js';
export type { TenantContext } from './tenant-context.js';
