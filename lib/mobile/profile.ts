import { NEUTRAL_THEME } from "@/lib/theme";
import { getTenantProfile, type TenantProfileRow } from "@/lib/db/tenants";
import { FORIT_HEX_WHITE_PATH, FORIT_MARK_COLOR_PATH, isForitTenant } from "@/lib/forit-brand";

const APEX = process.env.LMS_APEX_DOMAIN ?? "learn.forit.io";

export interface MobileProfile {
  user: { email: string; name: string; role: string };
  tenant: {
    slug: string;
    name: string;
    company_name: string;
    primary_color: string;
    accent_color: string;
    logo_url: string | null;
    // The white logo for a dark background (the app's profile menu in dark mode).
    logo_white_url: string | null;
    support_email: string | null;
  };
  // The tenant's own LMS host. The app sends every later call there, so a
  // tenant served on its own domain (learn.operator.example) is read
  // through that domain, as the web app is.
  api_base: string;
}

export function apiBaseFor(row: Pick<TenantProfileRow, "CustomHostname">): string {
  const host = row.CustomHostname?.trim().toLowerCase();
  return `https://${host || APEX}`;
}

function absolute(url: string | null, base: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, base).toString();
  } catch {
    return null;
  }
}

export function profileFromRow(
  row: TenantProfileRow,
  user: { email: string; name: string; role: string },
): MobileProfile {
  const apiBase = apiBaseFor(row);
  const forit = isForitTenant(row.Slug);
  return {
    user,
    tenant: {
      slug: row.Slug,
      name: row.Name,
      company_name: row.CompanyName ?? row.Name,
      primary_color: row.PrimaryColor ?? NEUTRAL_THEME.primary_color,
      accent_color: row.AccentColor ?? NEUTRAL_THEME.accent_color,
      logo_url: absolute(forit ? FORIT_MARK_COLOR_PATH : row.LogoUrl, apiBase),
      logo_white_url: absolute(forit ? FORIT_HEX_WHITE_PATH : row.LogoWhiteUrl, apiBase),
      support_email: row.SupportEmail,
    },
    api_base: apiBase,
  };
}

export async function mobileProfile(who: {
  tenantId: string;
  email: string;
  name: string;
  role: string;
}): Promise<MobileProfile> {
  const row = await getTenantProfile(who.tenantId);
  if (!row) throw new Error(`tenant ${who.tenantId} not found or inactive`);
  return profileFromRow(row, { email: who.email, name: who.name, role: who.role });
}
