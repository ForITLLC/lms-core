import type { FC, ReactNode } from "react";
import Link from "next/link";
import ShellRaw from "@/components/Shell";
import CreateWithAiForm from "@/components/author/CreateWithAiForm";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import { requireAuthorPage } from "@/lib/auth/author-page";
import { AI_AUTHORING_OFF, aiAuthoringEnabled } from "@/lib/ai/authoring/limits";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function CreateWithAiPage() {
  const access = await requireAuthorPage("/author/ingestions/new");
  if (!access.ok) {
    return (
      <Shell title="Create with AI">
        <NoTenantNotice />
      </Shell>
    );
  }
  const enabled = await aiAuthoringEnabled(access.tenantId);

  return (
    <Shell title="Create with AI">
      <div className="space-y-6">
        <Link href="/author" prefetch={false} className="text-sm font-semibold hover:underline" style={{ color: "var(--brand-primary)" }}>
          ← All courses
        </Link>
        {enabled ? <CreateWithAiForm /> : <p className="text-gray-700">{AI_AUTHORING_OFF}</p>}
      </div>
    </Shell>
  );
}
