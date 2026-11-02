import "server-only";
import type { AuthConfig, BaseSession } from "@foritllc/auth";
import { authConfig, type Role } from "@/lib/auth-config";
import { asRole } from "@/lib/auth/roles";
import { getAppUserRole, resolveTenantIdForSession, upsertAppUser } from "@/lib/db/users";
import { getHrAdminAdGroupId } from "@/lib/db/tenants";
import { getTransitiveGroupIds } from "@/lib/graph";

// Node-runtime extension of authConfig: layers on onSessionCreated which
// binds the LMS tenant by Entra tenant id (lib/auth/tenant-binding.ts, Security
// T-11: pinned tid first, email domain only when 0.7.0 verified it) and upserts
// lms.AppUser. Kept out of lib/auth-config.ts so the edge middleware bundle
// doesn't pull in tedious. Only the callback route imports this module.
//
// AAD authentication and LMS-tenant resolution are SEPARATE gates: a user
// whose domain matches no lms.Tenant row still gets a session (tenantId
// undefined). Pages render a "not bound to a tenant" notice and every data
// query stays tenant-scoped, so nothing leaks.
//
// Role + groups: a new lms.AppUser row is a learner. When the resolved tenant
// has HrAdminAdGroupId set we call Graph /users/{oid}/transitiveMemberOf (via
// lib/graph) to enumerate the user's AAD security-group memberships. A member
// of the HR-admin group becomes admin; a non-member keeps the stored role,
// except that a stored admin drops to author. The full group-id array is
// stamped onto the session so downstream code can compute group-driven
// required curricula (lms.CurriculumGroup, migration 0003) without re-hitting
// Graph.
//
// bindLmsSession is also the iPhone app's binding step (app/api/mobile/token),
// so a device key lands in exactly the tenant and role a web sign-in would.
export async function bindLmsSession(
  session: BaseSession,
): Promise<{ tenantId?: string; role?: string; groups?: string[] }> {
  const email = session.email.toLowerCase();
  let tenantId: string | null = null;
  try {
    tenantId = await resolveTenantIdForSession(session);
  } catch (e) {
    console.error("[LMS-AUTH] resolveTenantIdForSession failed; issuing unbound session", e);
  }

  if (!tenantId) return {};

  // Tenants without HrAdminAdGroupId manage roles in the database (a seed
  // migration or an admin), so the upsert leaves the stored Role alone and the
  // session role is read back from the row.
  let groups: string[] = [];
  let groupRole: "admin" | undefined;
  let groupManaged = false;
  try {
    const hrAdminGroupId = await getHrAdminAdGroupId(tenantId);
    if (hrAdminGroupId && session.azureOid) {
      groups = await getTransitiveGroupIds(session.azureOid);
      groupManaged = true;
      if (groups.includes(hrAdminGroupId)) groupRole = "admin";
    }
  } catch (e) {
    console.warn("[LMS-AUTH] group lookup failed; leaving stored role", e);
  }

  let role: Role = groupRole ?? "learner";
  try {
    await upsertAppUser({
      tenantId,
      email,
      displayName: session.name,
      azureOid: session.azureOid,
      role: groupRole,
      demoteAdmin: groupManaged && !groupRole,
    });
    role = asRole(await getAppUserRole(tenantId, email));
  } catch (e) {
    console.warn("[LMS-AUTH] upsertAppUser failed; session still issued", e);
  }

  return { tenantId, role, groups };
}

export const authConfigServer: AuthConfig = {
  ...authConfig,
  onSessionCreated: async (session: BaseSession) => bindLmsSession(session),
};
