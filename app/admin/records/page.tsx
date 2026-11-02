import type { FC, ReactNode } from "react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import ShellRaw from "@/components/Shell";
import RecordsManager from "@/components/RecordsManager";
import RecordsRoles from "@/components/RecordsRoles";
import { canGrantRecordsRoles, canReadRecords, recordsRights } from "@/lib/auth/records-permissions";
import { isStaffRole } from "@/lib/auth/roles";
import { listAppUsers } from "@/lib/db/users";
import { getSessionUser } from "@/lib/get-session";
import { trainingRecordsEnabled } from "@/lib/records/switch";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

// Training records (slices R2a and R2b), for a role that can read them
// (@/lib/auth/records-permissions) and only where the tenant's records are
// switched on; elsewhere the page doesn't exist. It shows only the parts the
// role holds the right for, and the API re-checks each. An instructor or a
// training manager can't open /admin, so their back link is the dashboard.
export default async function AdminRecordsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/records");
  if (!canReadRecords(session.role)) redirect(isStaffRole(session.role) ? "/admin" : "/dashboard");
  if (!session.tenantId) {
    return (
      <Shell title="Training records">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }
  if (!(await trainingRecordsEnabled(session.tenantId))) notFound();

  const back = isStaffRole(session.role) ? { href: "/admin", label: "← Admin" } : { href: "/dashboard", label: "← Dashboard" };
  const people = canGrantRecordsRoles(session.role)
    ? (await listAppUsers(session.tenantId)).map((p) => ({ appUserId: p.AppUserId.toLowerCase(), displayName: p.DisplayName, email: p.Email, role: p.Role }))
    : null;

  return (
    <Shell title="Training records">
      <div className="space-y-6">
        <Link href={back.href} prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
          {back.label}
        </Link>
        <RecordsManager rights={recordsRights(session.role)} signedInName={session.name} />
        {people ? <RecordsRoles people={people} /> : null}
      </div>
    </Shell>
  );
}
