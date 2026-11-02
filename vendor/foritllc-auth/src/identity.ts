// ============================================================================
// @foritllc/auth - Tenant-bound identity helpers (Security T-11, 2026-09-28)
//
// Authorize on WHO signed in (`tid` + `azureOid`, both from Microsoft), never
// on what their email looks like. An email domain is a label a foreign tenant
// can influence; a tenant id is not.
// ============================================================================

import type { BaseSession } from './types.js';

/** The ForIT corporate Entra tenant (login.microsoftonline.com/forit.io/v2.0/.well-known/openid-configuration). */
export const FORIT_TENANT_ID = 'c0efa09e-4bda-4a9d-a177-4c77076b7f76';

/** The issuer Entra ID v2.0 stamps on every token for `tid`. */
export function entraIssuer(tid: string): string {
  return `https://login.microsoftonline.com/${tid.toLowerCase()}/v2.0`;
}

/**
 * 0.8.0+: true when the session's `tid` came from an id_token the callback
 * validated (signature, issuer, audience, expiry, nonce). The callback stamps
 * the token's `iss` next to `tid`; a session without it — minted before 0.8.0,
 * or by an app calling `signSessionPayload` itself — carries a `tid` nobody
 * checked, and every helper below treats it as not in any tenant.
 */
export function sessionTenantValidated(session: Pick<BaseSession, 'tid' | 'iss'> | null | undefined): boolean {
  return (
    typeof session?.tid === 'string' &&
    typeof session.iss === 'string' &&
    session.iss.toLowerCase() === entraIssuer(session.tid)
  );
}

/**
 * Stable, rename-proof user key: `<tid>/<azureOid>`. Use it as the primary key
 * for app user rows and role grants. Returns null for a session whose `tid`
 * was not validated (see `sessionTenantValidated`) — treat that as
 * unauthenticated.
 */
export function sessionPrincipalKey(session: Pick<BaseSession, 'tid' | 'iss' | 'azureOid'> | null | undefined): string | null {
  if (!session?.tid || !session.azureOid || !sessionTenantValidated(session)) return null;
  return `${session.tid.toLowerCase()}/${session.azureOid.toLowerCase()}`;
}

/**
 * True when the session was minted by a MEMBER of one of the given Entra
 * tenants. This is the tenant-binding check: compare the tenant a request
 * wants to act in against this, never against a header, host name or query
 * parameter. Guests are excluded — a guest's `tid` is the tenant that invited
 * them, not the one they belong to. 0.8.0+: the `tid` must have come from a
 * validated id_token (`sessionTenantValidated`).
 */
export function sessionInTenant(
  session: Pick<BaseSession, 'tid' | 'iss' | 'isGuest'> | null | undefined,
  tenantIds: string | readonly string[],
): boolean {
  if (!session?.tid || session.isGuest === true || !sessionTenantValidated(session)) return false;
  const tid = session.tid.toLowerCase();
  const list = typeof tenantIds === 'string' ? [tenantIds] : tenantIds;
  return list.some((t) => t.toLowerCase() === tid);
}

/**
 * ForIT staff = a member of the ForIT Entra tenant, by the `tid` + `iss` of a
 * validated id_token. Never by email, UPN or `mail`. Replaces every
 * `email.endsWith('@forit.io')` admin check: in a multi-tenant app
 * (`allowedTenantIds: false`) any tenant's admin can make a user whose email
 * reads `@forit.io`; only ForIT can get Microsoft to sign a token with ForIT's
 * `tid`.
 */
export function isForitStaffSession(session: Pick<BaseSession, 'tid' | 'iss' | 'isGuest'> | null | undefined): boolean {
  return sessionInTenant(session, FORIT_TENANT_ID);
}

/**
 * The session's email, only if it may be used for an authorization decision
 * (matched against an allow-list or a tenant's email domains). Null for a
 * guest, or for a session minted before 0.7.0 that never had its email
 * checked against the tenant's verified domains.
 */
export function verifiedSessionEmail(session: Pick<BaseSession, 'email' | 'emailVerified'> | null | undefined): string | null {
  return session?.emailVerified === true && session.email ? session.email.toLowerCase() : null;
}
