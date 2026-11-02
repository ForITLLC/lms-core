import type { FC, ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import ShellRaw from "@/components/Shell";
import AiSettingsToggle from "@/components/AiSettingsToggle";
import { getSessionUser } from "@/lib/get-session";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

// The tenant's AI settings (slice A5b). Admins only: an author goes back to
// the admin home, a learner to their dashboard. The API re-checks the role.
export default async function AdminAiPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/ai");
  if (session.role === "author") redirect("/admin");
  if (session.role !== "admin") redirect("/dashboard");
  if (!session.tenantId) {
    return (
      <Shell title="AI settings">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  return (
    <Shell title="AI settings">
      <div className="space-y-6">
        <Link href="/admin" prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
          ← Admin
        </Link>
        <AiSettingsToggle />
      </div>
    </Shell>
  );
}
