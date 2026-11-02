import { queryOne } from "@/lib/db";
import { getLearningSummary } from "@/lib/db/learning-summary";
import { tenantOrigin } from "@/lib/email-optout";
import type { LearningSummaryFeed } from "@/lib/api/learning-summary-feed";

export async function readLearningSummaryFeed(tenantId: string, recipient: string): Promise<LearningSummaryFeed> {
  const tenant = await queryOne<{ Slug: string; CustomHostname: string | null }>(
    `SELECT Slug, CustomHostname FROM lms.Tenant WHERE TenantId = @tenantId`, { tenantId });
  if (!tenant) throw new Error("Key tenant not found");
  const summary = await getLearningSummary(tenantId, recipient);
  return { summary, summaryUrl: new URL("/dashboard/summary", tenantOrigin({ slug: tenant.Slug, customHostname: tenant.CustomHostname })).href };
}
