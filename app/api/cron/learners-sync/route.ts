import { NextRequest, NextResponse } from "next/server";
import { listLicensedUsers } from "@/lib/graph";
import { resolveLearner } from "@/lib/db/progress";
import { getThemeForSlug } from "@/lib/tenant";
import { queryOne } from "@/lib/db";

// Idempotent learner roster sync. Lists every licensed AAD user (via Graph
// App token in lib/graph.ts) and upserts an lms.Learner row for each so the
// dashboard + daily-digest know who exists before the first email lands.
//
// Bearer-CRON_SECRET protected — same gate as /api/cron/overdue-digest, so
// the same secret + scheduler can hit it. Lives under /api/cron/ (not
// /api/admin/) because middleware.ts protects /api/admin with the session
// cookie, which the cron caller doesn't carry. Per CLAUDE.md, cross-tenant
// data leaks are the #1 risk: every Learner upsert is scoped to a single
// tenant resolved from FORIT_TENANT_SLUG (or ?slug=...).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SyncResult {
  ok: boolean;
  tenant: string;
  synced: number;
  skipped: number;
  failures: Array<{ email: string; error: string }>;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization");
  const secret = process.env.CRON_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return new NextResponse("Forbidden", { status: 403 });
  }

  const slug =
    new URL(req.url).searchParams.get("slug") ??
    process.env.FORIT_TENANT_SLUG ??
    "forit";
  const theme = await getThemeForSlug(slug);
  if (!theme) {
    return NextResponse.json(
      { ok: false, error: `tenant '${slug}' not found` },
      { status: 404 },
    );
  }

  const tenantRow = await queryOne<{ TenantId: string }>(
    `SELECT CONVERT(varchar(64), TenantId) AS TenantId FROM lms.Tenant WHERE Slug = @slug`,
    { slug },
  );
  if (!tenantRow) {
    return NextResponse.json(
      { ok: false, error: `tenant row '${slug}' missing` },
      { status: 404 },
    );
  }

  const users = await listLicensedUsers();
  if (users.length === 0) {
    return NextResponse.json({
      ok: false,
      tenant: slug,
      synced: 0,
      skipped: 0,
      failures: [],
      hint: "Graph returned 0 users — check User.Read.All admin consent on the LMS app reg.",
    });
  }

  const result: SyncResult = {
    ok: true,
    tenant: slug,
    synced: 0,
    skipped: 0,
    failures: [],
  };

  for (const u of users) {
    try {
      await resolveLearner(
        tenantRow.TenantId,
        u.email,
        u.displayName,
        u.aadOid,
      );
      result.synced++;
    } catch (err) {
      result.failures.push({
        email: u.email,
        error: err instanceof Error ? err.message : String(err),
      });
      result.skipped++;
    }
  }
  result.ok = result.failures.length === 0;
  return NextResponse.json(result);
}
