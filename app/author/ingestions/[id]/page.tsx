import type { FC, ReactNode } from "react";
import { notFound } from "next/navigation";
import ShellRaw from "@/components/Shell";
import IngestionProgress from "@/components/author/IngestionProgress";
import NoTenantNotice from "@/components/author/NoTenantNotice";
import { requireAuthorPage } from "@/lib/auth/author-page";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

const INGESTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: Promise<{ id: string }>;
}

// The progress reads GET /api/author/ingestions/[id], which answers 404 for a
// job outside the session's tenant.
export default async function IngestionPage({ params }: PageProps) {
  const { id } = await params;
  const access = await requireAuthorPage(`/author/ingestions/${id}`);
  if (!access.ok) {
    return (
      <Shell title="Create with AI">
        <NoTenantNotice />
      </Shell>
    );
  }
  if (!INGESTION_ID.test(id)) notFound();

  return (
    <Shell title="Create with AI">
      <IngestionProgress ingestionId={id.toLowerCase()} />
    </Shell>
  );
}
