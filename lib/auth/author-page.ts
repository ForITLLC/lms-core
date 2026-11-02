import { redirect } from "next/navigation";
import { getSessionUser, type LmsSession } from "@/lib/get-session";
import { isStaffRole } from "@/lib/auth/roles";

// The one staff check for pages under app/author (app/author/author-pages.test.ts
// holds every page to it). Same order as lib/auth/staff-gate.ts: the tenant is
// checked before the role, so a session bound to no tenant hears why. A page
// passes a wider check only where the test names it: the marking queue takes
// canMarkExams, so an instructor reaches it and no other author page.

export const LEARNER_HOME = "/dashboard";

export type AuthorPageDecision = "login" | "no_tenant" | "not_staff" | "ok";

type RoleCheck = (role: string | undefined) => boolean;

export type AuthorPageAccess =
  | { ok: true; tenantId: string; email: string; staff: boolean }
  | { ok: false; reason: "no_tenant" };

export function authorPageDecision(session: Pick<LmsSession, "tenantId" | "role"> | null, allowed: RoleCheck = isStaffRole): AuthorPageDecision {
  if (!session) return "login";
  if (!session.tenantId) return "no_tenant";
  if (!allowed(session.role)) return "not_staff";
  return "ok";
}

// returnTo is built from the page's own URL, so anything that isn't a plain
// same-site path falls back to /author rather than reaching the login redirect.
export function authorLoginUrl(returnTo: string): string {
  const path = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/author";
  return `/api/auth/login?returnTo=${path.split("/").map(encodeURIComponent).join("/")}`;
}

// `staff` says whether the session may open the other author pages, so a
// page opened wider links to them only for staff.
export async function requireAuthorPage(returnTo: string, allowed: RoleCheck = isStaffRole): Promise<AuthorPageAccess> {
  const session = await getSessionUser();
  const decision = authorPageDecision(session, allowed);
  if (decision === "login") redirect(authorLoginUrl(returnTo));
  if (decision === "not_staff") redirect(LEARNER_HOME);
  if (decision === "no_tenant" || !session?.tenantId) return { ok: false, reason: "no_tenant" };
  return { ok: true, tenantId: session.tenantId, email: session.email, staff: isStaffRole(session.role) };
}
