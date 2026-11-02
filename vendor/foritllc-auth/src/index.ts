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

// Server-side session helper
export { createGetSession } from './get-session.js';

// Tenant resolution helper — bridges auth → @foritllc/tenant-theme
export { createGetTenantContext } from './tenant-context.js';
export type { TenantContext } from './tenant-context.js';
