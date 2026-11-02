import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { requestHost } from "@/lib/request-host";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Public, unauthenticated MCP manifest the for-mcp gateway registers from —
// binding contract: forit-Common docs/patterns/mcp-onboarding.md §4. The LMS
// runs no MCP server of its own (one MCP layer — the gateway); the gateway
// mounts the REST API described by /api/openapi.json with mechanism "openapi"
// and namespaces the operationIds as forit_learn_*. Served without auth —
// /api/mcp-manifest.json is in authConfig.publicPaths.

function originFrom(req: NextRequest): string {
  const host = requestHost(req.headers) ?? "localhost";
  const proto = host.startsWith("localhost") ? "http" : "https";
  return `${proto}://${host}`;
}

export function GET(req: NextRequest) {
  const origin = originFrom(req);
  return NextResponse.json({
    app: "learn",
    namespace: "forit_learn",
    baseUrl: `${origin}/api/v1`,
    mechanism: "openapi",
    specUrl: `${origin}/api/openapi.json`,
    auth: {
      family: "service-key",
      header: "Authorization",
      scheme: "Bearer",
      format: "Bearer {key}",
      envVar: "LEARN_MCP_API_KEY",
    },
    tenant: {
      // §2 Model B (per-user AAD role) app mounted as a single service
      // principal. The lms_<…> service bearer is tenant-scoped:
      // authenticateApiKey() resolves (tenantId, appUserId) from the key, so
      // the bearer CARRIES the tenant and no tenant arg reaches the backend —
      // single-tenant-per-key, declared "none" like the SMS exemplar.
      model: "none",
      arg: null,
      resolverTool: null,
    },
    destructiveGuard: false,
    tools: [
      "forit_learn_list_courses",
      "forit_learn_get_course",
      "forit_learn_list_learners",
      "forit_learn_get_progress",
      "forit_learn_compliance_summary",
    ],
  });
}
