import { noStoreJson, requireTenantRole, type StaffGate } from "@/lib/auth/staff-gate";
import { trainingRecordsEnabled } from "./switch";

export const RECORDS_SERVICE = "lms-records";

// The records routes of slice R2a (docs/plans/2026-10-29-training-records-design.md
// §3.1–§3.3): a member of the session's own tenant holding the route's right
// (@/lib/auth/records-permissions), and a tenant whose training records are
// switched on (./switch.ts). For any other tenant the routes don't exist, so
// they answer 404 as an unknown path does.
export async function requireRecordsRight(allowed: (role: string | undefined) => boolean): Promise<StaffGate> {
  const gate = await requireTenantRole(allowed);
  if (!gate.ok) return gate;
  if (!(await trainingRecordsEnabled(gate.tenantId))) return { ok: false, response: noStoreJson({ error: "Not found" }, 404) };
  return gate;
}
