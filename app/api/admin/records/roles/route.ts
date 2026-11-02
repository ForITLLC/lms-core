import { z } from "zod";
import { canGrantRecordsRoles, RECORDS_ROLES } from "@/lib/auth/records-permissions";
import { noStoreJson, staffRouteFailure } from "@/lib/auth/staff-gate";
import { listAppUsers, setRecordsRole } from "@/lib/db/users";
import { RECORDS_SERVICE, requireRecordsRight } from "@/lib/records/gate";
import { recordServiceRun } from "@/lib/logging";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The instructor and training-manager roles (card d3e16430, slice R2b). GET
// lists the people of the session's own tenant with their stored roles; PUT
// sets one person's role to learner, instructor or training_manager. Both
// need canGrantRecordsRoles, and only where the tenant's records are switched
// on, so nobody holds one of these roles before then. An admin or an author is
// never changed here (409), a person of another tenant is 404, and each change
// writes an AuditEvent in the same transaction. Nobody gets a role by signing
// in; a role taken away stops working within a minute (lib/db/users.ts).

const Body = z
  .object({
    appUserId: z.string().uuid(),
    role: z.enum(RECORDS_ROLES),
  })
  .strict();

export async function GET(): Promise<Response> {
  try {
    const gate = await requireRecordsRight(canGrantRecordsRoles);
    if (!gate.ok) return gate.response;
    const people = await listAppUsers(gate.tenantId);
    return noStoreJson({
      people: people.map((p) => ({ appUserId: p.AppUserId.toLowerCase(), displayName: p.DisplayName, email: p.Email, role: p.Role })),
      roles: RECORDS_ROLES,
    });
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}

export async function PUT(req: Request): Promise<Response> {
  const started = Date.now();
  try {
    const gate = await requireRecordsRight(canGrantRecordsRoles);
    if (!gate.ok) return gate.response;
    const body = Body.safeParse(await req.json().catch(() => null));
    if (!body.success) return noStoreJson({ error: "Send appUserId and a role: learner, instructor or training_manager." }, 400);
    const appUserId = body.data.appUserId.toLowerCase();

    const result = await setRecordsRole(gate.tenantId, appUserId, body.data.role, gate.email);
    switch (result.outcome) {
      case "not_found":
        return noStoreJson({ error: "Person not found" }, 404);
      case "other_role":
        return noStoreJson({ error: `This person's role is ${result.role}, which can't be changed here.`, code: "other_role" }, 409);
      case "changed":
      case "unchanged":
        await recordServiceRun(
          RECORDS_SERVICE,
          "SUCCESS",
          Date.now() - started,
          result.outcome === "changed" ? 1 : 0,
          `role.set tenant=${gate.tenantId} user=${appUserId} ${result.was}->${result.role}`,
        );
        return noStoreJson({ appUserId, role: result.role, was: result.was, changed: result.outcome === "changed" });
    }
  } catch (error) {
    return staffRouteFailure(RECORDS_SERVICE, error);
  }
}
