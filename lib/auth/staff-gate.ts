import { getSessionUser } from "@/lib/get-session";
import { isStaffRole } from "@/lib/auth/roles";
import { recordError } from "@/lib/logging";
import type { Role } from "@/lib/auth-config";

export type StaffGate =
  | { ok: true; tenantId: string; email: string; role: Role | undefined }
  | { ok: false; response: Response };

const NO_STORE = { "Cache-Control": "no-store" };

export function noStoreJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// An author or admin of the session's own tenant. The tenant is checked first
// so a session bound to no tenant hears why, not just "forbidden".
// getSessionUser re-reads the stored role, so a demotion takes effect at once.
export async function requireTenantStaff(): Promise<StaffGate> {
  return requireTenantRole(isStaffRole);
}

// An admin of the session's own tenant: an author is staff but not an admin.
export async function requireTenantAdmin(): Promise<StaffGate> {
  return requireTenantRole((role) => role === "admin");
}

// A member of the session's own tenant whose role the check allows.
export async function requireTenantRole(allowed: (role: string | undefined) => boolean): Promise<StaffGate> {
  const session = await getSessionUser();
  if (!session) return { ok: false, response: noStoreJson({ error: "Unauthenticated" }, 401) };
  if (!session.tenantId) return { ok: false, response: noStoreJson({ error: "No tenant" }, 400) };
  if (!allowed(session.role)) return { ok: false, response: noStoreJson({ error: "Forbidden" }, 403) };
  return { ok: true, tenantId: session.tenantId, email: session.email, role: session.role };
}

// An unexpected failure: logged by message only, never with the request body.
export async function staffRouteFailure(service: string, error: unknown): Promise<Response> {
  const message = error instanceof Error ? error.message : String(error);
  await recordError(service, message, "ERROR").catch(() => undefined);
  return noStoreJson({ error: "Something went wrong" }, 500);
}
