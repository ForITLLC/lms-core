import { queryOne } from "@/lib/db";
import type { TenantContentTokens } from "@/lib/tenant-tokens";

// Lightweight tenant lookups used outside the lib/tenant.ts theme cache —
// e.g. the auth-config-server reads HrAdminAdGroupId fresh on every sign-in
// so admin-role changes propagate without waiting on the 60s theme TTL.

export async function getHrAdminAdGroupId(
  tenantId: string,
): Promise<string | null> {
  const row = await queryOne<{ HrAdminAdGroupId: string | null }>(
    `SELECT HrAdminAdGroupId FROM lms.Tenant WHERE TenantId = @tenantId`,
    { tenantId },
  );
  return row?.HrAdminAdGroupId ?? null;
}

export async function getTenantSlug(tenantId: string): Promise<string | null> {
  const row = await queryOne<{ Slug: string }>(
    `SELECT Slug FROM lms.Tenant WHERE TenantId = @tenantId AND IsActive = 1`,
    { tenantId },
  );
  return row?.Slug ?? null;
}

// White-label content tokens for render-time {{...}} resolution in course
// bodies (see lib/tenant-tokens.ts). company_name + support_email come straight
// from branding; work_email_domain is read from SettingsJson.workEmailDomain —
// the independently-settable sign-in/UPN domain — falling back to the domain of
// the support email so a tenant that never set it still resolves something sane.
export async function getTenantContentTokens(
  tenantId: string,
): Promise<TenantContentTokens> {
  const row = await queryOne<{
    CompanyName: string | null;
    SupportEmail: string | null;
    SettingsJson: string | null;
  }>(
    `SELECT CompanyName, SupportEmail, SettingsJson
       FROM lms.TenantBranding WHERE TenantId = @tenantId`,
    { tenantId },
  );
  let workEmailDomain: string | null = null;
  if (row?.SettingsJson) {
    try {
      const settings = JSON.parse(row.SettingsJson) as { workEmailDomain?: unknown };
      if (typeof settings.workEmailDomain === "string" && settings.workEmailDomain.length > 0) {
        workEmailDomain = settings.workEmailDomain;
      }
    } catch {
      // Malformed SettingsJson — treat as unset.
    }
  }
  if (!workEmailDomain && row?.SupportEmail?.includes("@")) {
    workEmailDomain = row.SupportEmail.split("@")[1] ?? null;
  }
  return {
    company_name: row?.CompanyName ?? null,
    support_email: row?.SupportEmail ?? null,
    work_email_domain: workEmailDomain,
  };
}

export interface TenantProfileRow {
  Slug: string;
  Name: string;
  CustomHostname: string | null;
  CompanyName: string | null;
  LogoUrl: string | null;
  LogoWhiteUrl: string | null;
  PrimaryColor: string | null;
  AccentColor: string | null;
  SupportEmail: string | null;
}

// Name, host and brand for the iPhone app's tenant header (lib/mobile/profile.ts).
export async function getTenantProfile(tenantId: string): Promise<TenantProfileRow | null> {
  return queryOne<TenantProfileRow>(
    `SELECT t.Slug, t.Name, t.CustomHostname,
            b.CompanyName, b.LogoUrl, b.LogoWhiteUrl, b.PrimaryColor, b.AccentColor, b.SupportEmail
       FROM lms.Tenant t
       LEFT JOIN lms.TenantBranding b ON b.TenantId = t.TenantId
      WHERE t.TenantId = @tenantId AND t.IsActive = 1`,
    { tenantId },
  );
}
