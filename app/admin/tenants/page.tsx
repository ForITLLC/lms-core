import type { FC, ReactNode } from "react";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import { getSessionUser } from "@/lib/get-session";
import { isPlatformStaff } from "@/lib/auth/platform";
import { query } from "@/lib/db";
import TenantProvisionButton from "@/components/TenantProvisionButton";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

interface TenantRow {
  TenantId: string;
  Slug: string;
  Name: string;
  IsActive: number;
  CustomHostname: string | null;
  DnsProvisionedAt: Date | null;
}

export default async function AdminTenantsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/tenants");
  if (!(await isPlatformStaff(session))) {
    redirect("/dashboard");
  }

  const rows = await query<TenantRow>(
    `SELECT TenantId, Slug, Name, IsActive, CustomHostname, DnsProvisionedAt
     FROM lms.Tenant
     ORDER BY Slug`,
    {},
  );

  return (
    <Shell title="Tenants">
      <p className="text-gray-700 mb-6 max-w-prose">
        Tenants and their hostname provisioning state. The provision button
        upserts Cloudflare DNS, binds the hostname on Azure App Service, and
        stamps the tenant row.
      </p>

      <div className="space-y-3">
        {rows.map((t) => {
          const expectedHost = `${t.Slug}.learn.forit.io`;
          const provisioned = t.DnsProvisionedAt !== null;
          return (
            <Card key={t.TenantId} variant="white" padding="lg">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div
                    className="text-base font-semibold"
                    style={{ color: "var(--brand-primary)" }}
                  >
                    {t.Name}
                  </div>
                  <div className="text-sm text-gray-600">
                    slug: <span className="font-mono">{t.Slug}</span>
                    {t.IsActive === 0 && (
                      <span className="ml-2 rounded bg-gray-200 px-1.5 py-0.5 text-xs text-gray-700">
                        inactive
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-sm text-gray-700">
                    expected host:{" "}
                    <span className="font-mono">{expectedHost}</span>
                  </div>
                  <div className="text-sm text-gray-700">
                    custom hostname:{" "}
                    <span className="font-mono">
                      {t.CustomHostname ?? "—"}
                    </span>
                  </div>
                  <div className="text-sm text-gray-700">
                    provisioned:{" "}
                    {provisioned ? (
                      <span style={{ color: "var(--brand-accent)" }}>
                        {new Date(t.DnsProvisionedAt!).toISOString()}
                      </span>
                    ) : (
                      <span className="text-gray-500">not yet</span>
                    )}
                  </div>
                </div>

                {t.IsActive === 1 && (
                  <div className="min-w-[14rem]">
                    <TenantProvisionButton slug={t.Slug} />
                  </div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </Shell>
  );
}
