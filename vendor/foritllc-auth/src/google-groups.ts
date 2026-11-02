// ============================================================================
// @foritllc/auth - Google sign-in adapter: linked-principal group read (0.13.0)
//
// A Google principal reaches Entra groups only through a custodian-made link to
// one directory object in the customer's tenant, which forit-Auth returns as
// `identity.directory` on each verify (consumer contract §3; PR99 §6). This is
// the read for that object, with intra's contract: `null`, never `[]`, when
// membership cannot be trusted, and `null` hides every gated surface and
// refuses its API routes.
//
// DENIED BY DEFAULT. With no `linkedDirectory` configured, every Google
// principal gets `null`. The configuration cannot be built without an R-D2
// reader (type and enabled status by exact tenant and object id), which
// for-Directory has not served yet (Directory-msg).
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
import type { GooglePrincipal } from './principal.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function lower(value: unknown): string | null {
  return typeof value === 'string' ? value.toLowerCase() : null;
}

/**
 * The group object ids of a linked Google principal, or null on any doubt:
 * no link, a link whose source is not `link`, a tenant this app does not serve
 * on this host, a status answer for another tenant or object, an object that
 * is not `enabled === true`, a guest (or an unknown type) under the guest
 * policy, a reader error, or a malformed group answer. Never by email, UPN or
 * display name.
 */
export async function readLinkedGroupIds(
  linked: ResolvedLinkedDirectory | null,
  principal: GooglePrincipal | null | undefined,
): Promise<string[] | null> {
  if (!linked || !principal || principal.provider !== 'google') return null;
  const link = principal.directory;
  if (!link || link.source !== 'link') return null;
  const tenantId = lower(link.tenantId);
  const objectId = lower(link.objectId);
  if (!tenantId || !objectId || !UUID.test(tenantId) || !UUID.test(objectId)) return null;

  // Tenant binding (§3 rule 6): the tenant must be one this app serves, from
  // server configuration, with a tenant-scoped key. Never from the request.
  const tenant = linked.tenants.get(tenantId);
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
  if (!Array.isArray(groups) || !groups.every((g) => typeof g === 'string' && UUID.test(g))) return null;
  return groups.map((g) => g.toLowerCase());
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
