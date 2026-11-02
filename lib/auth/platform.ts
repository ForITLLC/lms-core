import type { LmsSession } from "@/lib/auth-config";
import { isStaffRole } from "@/lib/auth/roles";
import { isForitTenant } from "@/lib/db/catalogue";

// The tenant list and hostname provisioning span every tenant, so only staff
// of ForIT's own tenant reach them. An operator's admin stays inside its tenant.
export async function isPlatformStaff(session: Pick<LmsSession, "role" | "tenantId">): Promise<boolean> {
  if (!session.tenantId || !isStaffRole(session.role)) return false;
  return isForitTenant(session.tenantId);
}
