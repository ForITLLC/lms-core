import type { FC, ReactNode } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import ShellRaw from "@/components/Shell";
import ApiKeyManager, { type ApiKey } from "@/components/ApiKeyManager";
import { getSessionUser } from "@/lib/get-session";
import { resolveAppUserId } from "@/lib/db/users";
import { listApiKeys } from "@/lib/db/apiKeys";
import { requestHost } from "@/lib/request-host";

const Shell = ShellRaw as unknown as FC<{ children?: ReactNode; title?: string }>;

export const dynamic = "force-dynamic";

export default async function AdminIntegrationsPage() {
  const session = await getSessionUser();
  if (!session) redirect("/api/auth/login?returnTo=/admin/integrations");
  if (session.role !== "admin" && session.role !== "author") {
    redirect("/dashboard");
  }
  const tenantId = session.tenantId;
  if (!tenantId) {
    return (
      <Shell title="Integrations">
        <p className="text-gray-700">Your session isn&rsquo;t bound to a tenant.</p>
      </Shell>
    );
  }

  const appUserId = await resolveAppUserId(tenantId, session.email);
  const keysRaw = appUserId ? await listApiKeys(tenantId, appUserId) : [];
  const keys: ApiKey[] = keysRaw.map((k) => ({
    apiKeyId: k.apiKeyId,
    name: k.name,
    prefix: k.prefix,
    ownerOnly: k.ownerOnly,
    createdAt: k.createdAt.toISOString(),
    lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
    revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
  }));

  const hdrs = await headers();
  const host = requestHost(hdrs) ?? "localhost:3000";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const apiBaseUrl = `${proto}://${host}/api/v1`;
  const specUrl = `${proto}://${host}/api/openapi.json`;

  return (
    <Shell title="Integrations">
      <h1 className="text-xl font-semibold mb-2" style={{ color: "var(--brand-primary)" }}>
        Connect to your LMS
      </h1>
      <p className="text-gray-700 mb-6 max-w-prose">
        This LMS exposes a read-only API (
        <a
          href={specUrl}
          target="_blank"
          rel="noreferrer"
          className="underline"
          style={{ color: "var(--brand-primary)" }}
        >
          OpenAPI
        </a>
        ). An MCP gateway can mount it as tools for Claude, so you can ask about
        your courses, learners and compliance in plain language. The keys
        below authenticate your own scripts and integrations calling the API
        directly. Everything is read-only — nothing can be changed through it.
      </p>

      <Card variant="white" padding="lg" className="mb-6">
        <ApiKeyManager initialKeys={keys} apiBaseUrl={apiBaseUrl} specUrl={specUrl} />
      </Card>

      <Card variant="white" padding="lg">
        <h2 className="text-base font-semibold mb-2" style={{ color: "var(--brand-primary)" }}>
          What the API exposes
        </h2>
        <ul className="list-disc pl-5 text-sm text-gray-700 space-y-1">
          <li>
            <strong>list_courses</strong> — <code className="text-xs">GET /courses</code>{" "}
            — every course in your tenant.
          </li>
          <li>
            <strong>get_course</strong> — <code className="text-xs">GET /courses/{"{slug}"}</code>{" "}
            — a course&rsquo;s lessons with block and quiz counts.
          </li>
          <li>
            <strong>list_learners</strong> — <code className="text-xs">GET /learners</code>{" "}
            — your learners and their latest training activity.
          </li>
          <li>
            <strong>get_progress</strong> —{" "}
            <code className="text-xs">GET /courses/{"{slug}"}/progress</code> — per-learner
            completion for a course.
          </li>
          <li>
            <strong>compliance_summary</strong> — <code className="text-xs">GET /compliance</code>{" "}
            — mandatory-training done vs outstanding across the tenant.
          </li>
        </ul>
        <p className="mt-3 text-xs text-gray-500">
          Every request is scoped to your tenant by the API key it carries.
        </p>
      </Card>
    </Shell>
  );
}
