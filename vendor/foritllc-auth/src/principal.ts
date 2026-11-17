// ============================================================================
// @foritllc/auth - Provider-discriminated identity (0.13.0; labelled link targets 0.24.0)
//
// The consumer contract's section 2 (docs/plans/2026-10-28-google-sign-in-
// consumer-contract.md). An Entra session stays today's BaseSession, byte for
// byte: the callback never writes `provider`, and a payload with no `provider`
// is Entra. Only `entraPrincipal()` adds the discriminator, in memory.
//
// A Google principal is forit-Auth's verified issuer plus Google's `sub`. It has
// no `tid` or `azureOid`, and the type forbids them, so no helper that reads a
// tenant can mistake it for a Microsoft sign-in. Its only route to groups is
// `directory`, a custodian-made link forit-Auth returns on each verify.
//
// 0.24.0 (ADR 0022 amendment 2026-11-07, Tasks 3CA5AD85, C4): the link names
// one of two targets, labelled by `kind`. An Entra object (today's shape: the
// customer's tenant and object id) or a for-Directory person (the customer's
// Directory partition and Directory's own person id), for a customer that
// has no Entra members. Auth sends the labelled target in a new
// `target` object on verify and keeps today's `directory` byte-identical for
// an Entra object (for-Auth DBECB392). `parseDirectoryLink` is the one reader
// of that label; anything it cannot place exactly is refused.
//
// G1 (for-Architecture A969B4BE, for-Common 49C0959D): for a Google-synced
// partition, Directory holds the person's Google directory id as its synced
// external id, and only Auth resolves a sign-in by it, server to server. The
// Google id never reaches this package: a person target names Directory's own
// person id (a GUID), with `source: 'sync'`.
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

/** forit-Auth's `identity.directory` naming an Entra object, Google case only (PR99 §4.1). */
export interface EntraObjectLink {
  /**
   * 0.24.0. Accepted on input; never set on the link `parseDirectoryLink`
   * returns, so an Entra link reaches the app byte for byte as in 0.23.x
   * (`{ tenantId, objectId, source }`). A link is an Entra object whenever its
   * `kind` is not `directory-person`.
   */
  kind?: 'entra-object';
  /** The customer's Entra tenant, lower case. */
  tenantId: string;
  /** The linked directory user object, lower case. */
  objectId: string;
  /** Never on an Entra-object link; typed so `directory?.partitionId` still compiles. */
  partitionId?: never;
  personId?: never;
  /** A Google identity whose directory has any other source is refused. */
  source: 'link';
}

/**
 * 0.24.0. forit-Auth's verify `target` naming a for-Directory person: a
 * customer with no Entra members (ADR 0022 amendment 2026-11-07,
 * Tasks 3CA5AD85, C4 and G1). Auth resolved the Google sign-in to this person
 * (A969B4BE G1: by exact issuer and `sub` against Directory's synced external
 * id, server to server); the Google id itself is never here.
 */
export interface DirectoryPersonLink {
  /** Always sent by Auth: an unlabelled person link is refused. */
  kind: 'directory-person';
  /**
   * The customer's for-Directory partition id (a GUID), lower case. It must
   * exactly equal a partition this app's `linkedDirectory.partitions` serves,
   * or the group read denies.
   */
  partitionId: string;
  /**
   * Directory's own permanent person id in that partition (a GUID; for-Directory
   * A07460F3), lower case and compared exactly. Never a Google id or an email.
   */
  personId: string;
  /**
   * Never on a Directory-person link; typed so today's `directory?.tenantId`
   * still compiles (it reads `undefined` here, so a tenant check denies).
   */
  tenantId?: never;
  objectId?: never;
  /**
   * How Auth tied the Google sign-in to this person: one of
   * `DIRECTORY_PERSON_LINK_SOURCES`, and nothing else is accepted.
   */
  source: DirectoryPersonLinkSource;
}

/** The link's target, labelled by `kind` (C4). */
export type DirectoryLink = EntraObjectLink | DirectoryPersonLink;

/** The two `kind` labels Common reads. Any other label is refused. */
export const DIRECTORY_LINK_KINDS = Object.freeze(['entra-object', 'directory-person'] as const);

/**
 * 0.24.0. The ONE list of `source` values accepted on a Directory-person
 * link: how forit-Auth tied the Google sign-in to that person.
 * - `link`: a link row Auth holds.
 * - `sync`: Auth matched the Google issuer and `sub` exactly against the
 *   Google directory id Directory's sync wrote, in the app row's partition
 *   (for-Auth DBECB392; for-Architecture A969B4BE G1). This is how Auth
 *   resolved the person. It is not Directory's row marker `google-sync`, a
 *   separate field that is never accepted here.
 * Any value not listed is refused. An Entra-object link keeps its 0.23.x
 * rule: `source` exactly `link` (a Google sign-in reaches an Entra object only
 * through Auth's link row; `token` is an Entra sign-in's, which this adapter
 * refuses by provider).
 */
export const DIRECTORY_PERSON_LINK_SOURCES = Object.freeze(['link', 'sync'] as const);

/** A `source` value accepted on a Directory-person link. */
export type DirectoryPersonLinkSource = (typeof DIRECTORY_PERSON_LINK_SOURCES)[number];

function personSource(value: unknown): DirectoryPersonLinkSource | null {
  return typeof value === 'string' && (DIRECTORY_PERSON_LINK_SOURCES as readonly string[]).includes(value)
    ? (value as DirectoryPersonLinkSource)
    : null;
}

const LINK_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRA_KEYS = ['tenantId', 'objectId'] as const;
const PERSON_KEYS = ['partitionId', 'personId'] as const;

function linkObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function linkId(value: unknown, lowerCase: boolean): string | null {
  if (typeof value !== 'string') return null;
  const id = lowerCase ? value.toLowerCase() : value;
  return LINK_UUID.test(id) ? id : null;
}

/**
 * 0.24.0. The one reader of forit-Auth's link label (C4), for verify's
 * `target` and for its `directory`. It returns a frozen link, or null on any
 * doubt:
 *
 * - An Entra-object link's `source` must be exactly `link`; a
 *   Directory-person link's must be one of `DIRECTORY_PERSON_LINK_SOURCES`.
 * - `kind: 'entra-object'` needs a GUID `tenantId` and `objectId`.
 * - `kind: 'directory-person'` needs a GUID `partitionId` and `personId`.
 * - No `kind` at all, with today's exact Entra shape, is an Entra object: that
 *   is what Auth sends in `directory` (for-Auth `appSignIn.ts` `directoryOf`),
 *   and the Entra read keeps its tenant binding, status and guest checks. A
 *   person link with no label is refused: the new target is never guessed
 *   from its shape. `labelled: true` (verify's `target`) refuses an
 *   unlabelled link of either shape.
 * - Any other `kind` (unknown, `null`, not a string), and any link that carries
 *   a field of both shapes (even `null`), is refused.
 *
 * The Entra link it returns carries no `kind`, so it is byte for byte the
 * 0.23.x object; a person link always carries `kind: 'directory-person'`.
 *
 * By default ids must already be lower case, as Auth sends them (an upper-case
 * id from Auth is refused). `lowerCase: true` folds case first; the group
 * reader uses it to re-read a principal's link without trusting it.
 */
export function parseDirectoryLink(
  raw: unknown,
  options: { lowerCase?: boolean; labelled?: boolean } = {},
): DirectoryLink | null {
  if (!linkObject(raw)) return null;
  const lowerCase = options.lowerCase === true;
  const hasEntra = ENTRA_KEYS.some((key) => raw[key] !== undefined);
  const hasPerson = PERSON_KEYS.some((key) => raw[key] !== undefined);
  if (hasEntra && hasPerson) return null;
  const kind = raw.kind;
  if (kind === 'directory-person') {
    if (hasEntra) return null;
    const source = personSource(raw.source);
    const partitionId = linkId(raw.partitionId, lowerCase);
    const personId = linkId(raw.personId, lowerCase);
    if (!source || !partitionId || !personId) return null;
    return Object.freeze({ kind: 'directory-person' as const, partitionId, personId, source });
  }
  if (kind === 'entra-object' || (kind === undefined && options.labelled !== true)) {
    if (hasPerson || raw.source !== 'link') return null;
    const tenantId = linkId(raw.tenantId, lowerCase);
    const objectId = linkId(raw.objectId, lowerCase);
    if (!tenantId || !objectId) return null;
    return Object.freeze({ tenantId, objectId, source: 'link' as const });
  }
  return null;
}

/**
 * 0.24.0. True when two links name the same target: the same kind, the same
 * ids and the same source. Verify's `target` and `directory` must agree when
 * Auth sends both.
 */
export function sameDirectoryLink(a: DirectoryLink, b: DirectoryLink): boolean {
  if (a.kind === 'directory-person' || b.kind === 'directory-person') {
    return (
      a.kind === 'directory-person' &&
      b.kind === 'directory-person' &&
      a.partitionId === b.partitionId &&
      a.personId === b.personId &&
      a.source === b.source
    );
  }
  return a.tenantId === b.tenantId && a.objectId === b.objectId && a.source === b.source;
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
  /**
   * From this request's verify only (R-C1). An Entra object or (0.24.0) a
   * Directory person: Auth's `target` when it sends one, otherwise its
   * `directory`, which can only name an Entra object.
   */
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
