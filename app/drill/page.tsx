import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import ShellRaw from "@/components/Shell";
import ComingSoon from "@/components/ComingSoon";
import DrillPlayer from "@/components/drill/DrillPlayer";
import { getSessionUser } from "@/lib/get-session";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function DrillPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/drill");
  if (!session.tenantId) {
    return (
      <Shell title="Daily drill">
        <ComingSoon
          title="No tenant resolved"
          description="Your session isn't bound to a tenant yet. Sign out and back in, or contact your administrator."
        />
      </Shell>
    );
  }
  return (
    <Shell title="Daily drill">
      <DrillPlayer />
    </Shell>
  );
}
