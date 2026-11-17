// ============================================================================
// @foritllc/auth - Google sign-in adapter: linked-principal group read (0.13.0, 0.24.0)
//
// A Google principal reaches groups only through the link forit-Auth returns
// on each verify (consumer contract §3; PR99 §6): today's `identity.directory`
// for an Entra object, and from 0.24.0 the labelled `identity.target` (for-Auth
// DBECB392). This is the read for that link's target, with intra's
// contract: `null`, never `[]`, when membership cannot be trusted, and `null`
// hides every gated surface and refuses its API routes.
//
// The target is labelled (0.24.0, C4; ADR 0022 amendment 2026-11-07, Tasks
// 3CA5AD85), and each kind has its own read:
// - `entra-object`: today's read, unchanged. The customer's Entra tenant and
//   object id, an R-D2 status read, the app's guest policy, then the group ids.
// - `directory-person`: a customer with no Entra members. The
//   partition must exactly equal one the app serves; then ONE read of that
//   person's status and Directory-mastered groups by Directory's own ids
//   (GUIDs, compared exactly in lower case). That status read replaces the
//   Entra guest check (C3); it is never skipped. Under G1 (for-Architecture
//   A969B4BE) Directory's groups for a Google-synced person come from the
//   customer's own Google groups: direct USER members only.
//
// DENIED BY DEFAULT. With no `linkedDirectory` configured, every Google
// principal gets `null`; with no partition configured, every Directory-person
// link gets `null`. The configuration cannot be built without a status reader
// for each tenant and partition, and for-Directory serves neither the R-D2
// route nor the person-id route (A1) yet.
//
// R-C1: the read uses only the `directory` of the principal the current
// request's verify returned, and keeps nothing: no link, status or group
// answer goes in a cookie, a module-level cache or any store.
//
// Provenance: `createLinkedGroupReader` answers only for principal objects
// that the same adapter's own `session()` verify returned in this process. A
// hand-built object, a JSON copy, a spread copy or another adapter's principal
// gets null. That brand is provenance only; freshness still comes from
// per-request verification. An app that keeps a verified principal object
// past its request still holds a branded object, so the rule stays: pass only
// the principal THIS request's verify returned.
// ============================================================================

import type { ResolvedLinkedDirectory } from './google-config.js';
import {
  type DirectoryPersonLink,
  type EntraObjectLink,
  type GooglePrincipal,
  parseDirectoryLink,
} from './principal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A list of group ids, every one a GUID, in lower case; null for anything else. */
function groupIds(groups: unknown): string[] | null {
  if (!Array.isArray(groups) || !groups.every((g) => typeof g === 'string' && UUID.test(g))) return null;
  return groups.map((g: string) => g.toLowerCase());
}

/** Today's Entra-object read (0.13.0), unchanged. */
async function readEntraObjectGroupIds(linked: ResolvedLinkedDirectory, link: EntraObjectLink): Promise<string[] | null> {
  const { tenantId, objectId } = link;

  // Tenant binding (§3 rule 6): the tenant must be one this app serves, from
  // server configuration, with a tenant-scoped key. Never from the request.
  const tenant = linked.tenants?.get(tenantId);
  if (!tenant || tenant.tenantScoped !== true) return null;
  const target = Object.freeze({ tenantId, objectId });

  // R-D2 (§3 rule 7): exactly this tenant and object, enabled, and the guest
  // policy with no exception for the link (rule 5).
  let status: Awaited<ReturnType<typeof tenant.readObjectStatus>>;
  try {
    status = await tenant.readObjectStatus(target);
  } catch {
    return null;
  }
  if (!status || typeof status !== 'object') return null;
  if (lower(status.tenantId) !== tenantId || lower(status.objectId) !== objectId) return null;
  if (status.enabled !== true) return null;
  if (linked.rejectGuests && status.guest !== false) return null;

  // Group ids by object id (§3 step 4).
  let groups: Awaited<ReturnType<typeof tenant.readGroupIds>>;
  try {
    groups = await tenant.readGroupIds(target);
  } catch {
    return null;
  }
  return groupIds(groups);
}

/**
 * 0.24.0 (C3, C4). A Directory person's groups: the partition must be one this
 * app serves, from server configuration, with that partition's own scoped key;
 * then one read by exact partition and person id. Null unless the answer is an
 * object that echoes both ids, says `enabled === true`, and lists only
 * Directory's permanent group ids. A bare list (`200 []`), a 404 (null or a
 * throw), a disabled or unknown person, or a malformed group id all deny.
 */
async function readDirectoryPersonGroupIds(
  linked: ResolvedLinkedDirectory,
  link: DirectoryPersonLink,
): Promise<string[] | null> {
  const { partitionId, personId } = link;
  const partition = linked.partitions?.get(partitionId);
  if (!partition || partition.partitionScoped !== true || typeof partition.readPersonAccess !== 'function') return null;
  const target = Object.freeze({ partitionId, personId });

  let access: unknown;
  try {
    access = await partition.readPersonAccess(target);
  } catch {
    return null;
  }
  // Only a positive status read counts: never a bare list or an empty answer.
  if (!isRecord(access)) return null;
  // The answer must be about exactly the person asked for: an echoed id that
  // differs (or is missing) denies.
  if (lower(access.partitionId) !== partitionId || lower(access.personId) !== personId) return null;
  if (access.enabled !== true) return null;
  // `asOf` and any other field are ignored: read nothing else, pass nothing on.
  return groupIds(access.groups);
}

/**
 * The group ids of a linked Google principal, or null on any doubt: no link, a
 * link whose source or target `parseDirectoryLink` cannot place (an Entra
 * source other than `link`, a person source not in
 * `DIRECTORY_PERSON_LINK_SOURCES`, an unknown kind, both shapes, an
 * unlabelled person), a tenant or a
 * partition this app does not serve on this host (matched exactly), a status answer for another
 * tenant, object, partition or person, a target that is not
 * `enabled === true`, an Entra guest (or an unknown type) under the guest
 * policy, a reader error, or a malformed group answer. Never by email, UPN,
 * Google id or display name.
 */
export async function readLinkedGroupIds(
  linked: ResolvedLinkedDirectory | null,
  principal: GooglePrincipal | null | undefined,
): Promise<string[] | null> {
  if (!linked || !principal || principal.provider !== 'google') return null;
  // Read the label again rather than trust the object's shape.
  const link = parseDirectoryLink(principal.directory, { lowerCase: true });
  if (!link) return null;
  return link.kind === 'directory-person'
    ? readDirectoryPersonGroupIds(linked, link)
    : readEntraObjectGroupIds(linked, link);
}

/** One adapter's group read, limited to the principals that adapter's verify returned. */
export interface LinkedGroupReader {
  /** Brand a principal that this adapter's `session()` verify just returned. */
  admit(principal: GooglePrincipal): GooglePrincipal;
  /** `readLinkedGroupIds` for a branded principal; null for any other object. */
  read(principal: GooglePrincipal | null | undefined): Promise<string[] | null>;
}

/**
 * A per-adapter reader. Its WeakSet holds no positive answer and nothing about
 * the session: it records only that this adapter's verify produced the object
 * (provenance), and drops it once the app lets go of the object. It is not a
 * freshness check: R-C1 is still kept by verifying on every request.
 */
export function createLinkedGroupReader(linked: ResolvedLinkedDirectory | null): LinkedGroupReader {
  const verified = new WeakSet<GooglePrincipal>();
  return {
    admit(principal) {
      verified.add(principal);
      return principal;
    },
    async read(principal) {
      if (!principal || typeof principal !== 'object' || !verified.has(principal)) return null;
      return readLinkedGroupIds(linked, principal);
    },
  };
}
