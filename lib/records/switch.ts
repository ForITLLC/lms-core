import { getTenantSlug } from "@/lib/db/tenants";

// Which tenants get training records (docs/plans/2026-10-29-training-records-design.md
// §7). Records are T1 people records: a tenant whose people must stay in
// Canada gets none until the LMS has a Canada stamp and its own database per
// client, so the writers run only for the tenants listed in
// TRAINING_RECORDS_TENANTS (comma-separated tenant ids or slugs). Unset or
// empty, they run for no tenant, and no tenant is looked up. Parsed the way
// AI_AUTHORING_TENANTS is (lib/ai/authoring/limits.ts).
export async function trainingRecordsEnabled(
  tenantId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const listed = new Set(
    (env.TRAINING_RECORDS_TENANTS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  if (listed.size === 0) return false;
  if (listed.has(tenantId.toLowerCase())) return true;
  const slug = await getTenantSlug(tenantId);
  return slug !== null && listed.has(slug.toLowerCase());
}
