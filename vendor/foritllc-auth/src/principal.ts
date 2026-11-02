// ============================================================================
// @foritllc/auth - Provider-discriminated identity (0.13.0)
//
// The consumer contract's section 2 (docs/plans/2026-10-28-google-sign-in-
// consumer-contract.md). An Entra session stays today's BaseSession, byte for
// byte: the callback never writes `provider`, and a payload with no `provider`
// is Entra. Only `entraPrincipal()` adds the discriminator, in memory.
//
// A Google principal is forit-Auth's verified issuer plus Google's `sub`. It has
// no `tid` or `azureOid`, and the type forbids them, so no helper that reads a
// tenant can mistake it for a Microsoft sign-in. Its only route to Entra groups
// is `directory`, a custodian-made link forit-Auth returns on each verify.
// ============================================================================

import { sessionTenantValidated } from './identity.js';
import type { BaseSession } from './types.js';

/** Today's BaseSession, unchanged, with the discriminator added in memory. */
export interface EntraPrincipal {
  provider: 'entra';
  /** From a validated id_token. */
  tid: string;
  /** `https://login.microsoftonline.com/<tid>/v2.0`. */
  iss: string;
  /** Today's field name, kept for byte compatibility. */
  azureOid: string;
  /** A label. */
  email: string;
  emailVerified?: boolean;
  isGuest?: boolean;
  /** A label. */
  name: string;
  loginHint?: string;
  expiresAt: number;
}

/** forit-Auth's `identity.directory`, Google case only (PR99 §4.1). */
export interface DirectoryLink {
  /** The customer's Entra tenant, lower case. */
  tenantId: string;
  /** The linked directory user object, lower case. */
  objectId: string;
  /** A Google identity whose directory has any other source is refused. */
  source: 'link';
}

/**
 * A Google sign-in, built from ONE verify answer (PR99 §4.2) and alive for one
 * request. Never put it in a cookie, a cache or a store (R-C1): the next
 * request verifies again, so a disabled link or membership takes effect at once.
 */
export interface GooglePrincipal {
  provider: 'google';
  /** PR99 §1, fixed. Anything else is refused. */
  issuer: 'https://accounts.google.com';
  /** Google `sub`, compared exactly. Key non-entitlement data on (issuer, subject). */
  subject: string;
  /** forit-Auth's AccessPrincipals id. */
  principalId: string;
  /** Equals the configured workspaceId. */
  workspaceId: string;
  /** forit-Auth's AppSessions.Id, for audit only. */
  sessionId: string;
  /** Equals this app's registered id. */
  appId: string;
  /** Equals this app's origin. */
  audience: string;
  /** A label. Never decides identity, staff status, tenancy, a link or a role. */
  displayName: string;
  /** From this request's verify only (R-C1). */
  directory?: DirectoryLink;
  /** PR99 `identity.expiresAt`, as ms since epoch. */
  expiresAt: number;
  tid?: never;
  azureOid?: never;
  email?: never;
  isGuest?: never;
  emailVerified?: never;
}

export type SignedInPrincipal = EntraPrincipal | GooglePrincipal;

/**
 * The Entra principal for a session from `parseSessionCookie`, or null when its
 * `tid` was not validated. Adds `provider: 'entra'` in memory only; the cookie
 * is never rewritten.
 */
export function entraPrincipal(session: BaseSession | null | undefined): EntraPrincipal | null {
  if (!session || !sessionTenantValidated(session) || typeof session.azureOid !== 'string') return null;
  const principal: EntraPrincipal = {
    provider: 'entra',
    tid: session.tid as string,
    iss: session.iss as string,
    azureOid: session.azureOid,
    email: session.email,
    name: session.name,
    expiresAt: session.expiresAt,
  };
  if (typeof session.emailVerified === 'boolean') principal.emailVerified = session.emailVerified;
  if (typeof session.isGuest === 'boolean') principal.isGuest = session.isGuest;
  if (typeof session.loginHint === 'string') principal.loginHint = session.loginHint;
  return principal;
}

/** True for a Google principal. */
export function isGooglePrincipal(principal: SignedInPrincipal | null | undefined): principal is GooglePrincipal {
  return principal?.provider === 'google';
}
