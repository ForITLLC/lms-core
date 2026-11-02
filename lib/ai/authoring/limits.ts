import { getTenantSlug } from "@/lib/db/tenants";
import type { EnqueueLimits } from "@/lib/db/ingestions";

// How much AI authoring a tenant may start, and whether it may start any
// (docs/plans/2026-10-29-ai-authoring.md, slice A4). The numbers are the
// starting answers on card f84f7899; a different answer changes this file and
// nothing else. Every job counts against them, whatever became of it, since a
// failed job may still have spent tokens.

// Jobs queued or running at once, per tenant.
export const MAX_ACTIVE_JOBS = 2;
// Jobs started per calendar month (UTC), per tenant.
export const MAX_JOBS_PER_MONTH = 20;

export const INGESTION_LIMITS: EnqueueLimits = { maxActive: MAX_ACTIVE_JOBS, maxPerMonth: MAX_JOBS_PER_MONTH };

export const AI_AUTHORING_OFF = "AI course drafting isn't turned on for this organisation.";

export function limitMessage(reached: "active" | "monthly"): string {
  return reached === "active"
    ? `Your organisation already has ${MAX_ACTIVE_JOBS} AI drafts in progress, the most at once. Try again when one has finished.`
    : `Your organisation has started ${MAX_JOBS_PER_MONTH} AI drafts this month, the monthly limit. More can start from the 1st of next month (UTC).`;
}

// The off switch: AI authoring is on only for the tenants whose slugs are in
// AI_AUTHORING_TENANTS (comma-separated). Unset or empty, it is off for every
// tenant, and it stays empty until card f84f7899 is decided. With the list
// empty the tenant isn't even looked up.
export async function aiAuthoringEnabled(
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const allowed = new Set(
    (env.AI_AUTHORING_TENANTS ?? "")
      .split(",")
      .map((slug) => slug.trim().toLowerCase())
      .filter(Boolean),
  );
  if (allowed.size === 0) return false;
  const slug = await getTenantSlug(tenantId);
  return slug !== null && allowed.has(slug.toLowerCase());
}
