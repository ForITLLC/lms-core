import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { NEUTRAL_THEME, type TenantTheme } from "@/lib/theme";
import { query } from "@/lib/db";
import { FORIT_HEX_WHITE_PATH, FORIT_MARK_COLOR_PATH, isForitTenant } from "@/lib/forit-brand";
import { requestHost } from "@/lib/request-host";

// Tenant branding lives in lms.TenantBranding. We pull every active tenant in
// one query on the first request and cache the result for 60s — new tenants
// onboarded via /api/admin/tenants/[slug]/provision-dns become visible on the
// next minute boundary, which is plenty fast.
//
// Resolution order: CustomHostname exact match (e.g. learn.operator.example)
// → subdomain (<slug>.learn.forit.io) → the app's own hosts. Foreign-hosted
// tenants live on their own brand domain; ForIT-hosted tenants live on a
// subdomain of learn.forit.io. The app's own hosts (the apex, www, localhost,
// the App Service default host) resolve to the canonical 'forit' tenant —
// falling back to NEUTRAL_THEME there would show the slate-grey
// placeholder to public visitors. Any other host is unknown and gets a 404,
// never another tenant's brand.

const TTL_MS = 60_000;
const APEX = process.env.LMS_APEX_DOMAIN ?? "learn.forit.io";
const APEX_TENANT_SLUG = process.env.LMS_APEX_TENANT_SLUG ?? "forit";

export interface BrandingRow {
  Slug: string;
  Name: string;
  AadTenantId: string | null;
  CustomHostname: string | null;
  CompanyName: string | null;
  LogoUrl: string | null;
  LogoWhiteUrl: string | null;
  FaviconUrl: string | null;
  PrimaryColor: string | null;
  SecondaryColor: string | null;
  AccentColor: string | null;
  FontFamily: string | null;
  SupportEmail: string | null;
  SupportPhone: string | null;
  WelcomeText: string | null;
  PortalWelcomeText: string | null;
  CustomCss: string | null;
  EmailSenderAddress: string | null;
  EmailSenderDisplayName: string | null;
  TenantId: string;
}

let cache: { at: number; themes: TenantTheme[] } | null = null;

export function rowToTheme(r: BrandingRow): TenantTheme {
  const aad = r.AadTenantId ? r.AadTenantId.toLowerCase() : undefined;
  const forit = isForitTenant(r.Slug);
  return {
    tenant_id: aad ?? r.TenantId,
    slug: r.Slug,
    name: r.Name,
    domain: r.CustomHostname ?? undefined,
    aad_tenant_id: aad,
    company_name: r.CompanyName ?? r.Name,
    primary_color: r.PrimaryColor ?? NEUTRAL_THEME.primary_color,
    secondary_color: r.SecondaryColor ?? NEUTRAL_THEME.secondary_color,
    accent_color: r.AccentColor ?? NEUTRAL_THEME.accent_color,
    font_family: r.FontFamily ?? NEUTRAL_THEME.font_family,
    logo_url: forit ? FORIT_MARK_COLOR_PATH : r.LogoUrl ?? undefined,
    logo_white_url: forit ? FORIT_HEX_WHITE_PATH : r.LogoWhiteUrl ?? undefined,
    favicon_url: forit ? FORIT_MARK_COLOR_PATH : r.FaviconUrl ?? undefined,
    support_email: r.SupportEmail ?? undefined,
    support_phone: r.SupportPhone ?? undefined,
    welcome_text: r.WelcomeText ?? undefined,
    portal_welcome_text: r.PortalWelcomeText ?? undefined,
    custom_css: r.CustomCss ?? undefined,
    email_sender:
      r.EmailSenderAddress && r.EmailSenderDisplayName
        ? { address: r.EmailSenderAddress, display_name: r.EmailSenderDisplayName }
        : undefined,
  };
}

async function loadThemes(): Promise<TenantTheme[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.themes;
  // During `next build` there are no SQL creds (Managed Identity only resolves
  // inside App Service) — return an empty set so prerender falls through to
  // NEUTRAL_THEME instead of logging a login failure on every static page.
  if (process.env.NEXT_PHASE === "phase-production-build") {
    cache = { at: now, themes: [] };
    return cache.themes;
  }
  let themes: TenantTheme[];
  try {
    const rows = await query<BrandingRow>(
      `SELECT t.Slug, t.Name,
              CONVERT(varchar(64), t.AadTenantId) AS AadTenantId,
              t.CustomHostname,
              b.CompanyName, b.LogoUrl, b.LogoWhiteUrl, b.FaviconUrl,
              b.PrimaryColor, b.SecondaryColor, b.AccentColor, b.FontFamily,
              b.SupportEmail, b.SupportPhone, b.WelcomeText, b.PortalWelcomeText,
              b.CustomCss, b.EmailSenderAddress, b.EmailSenderDisplayName,
              CONVERT(varchar(64), t.TenantId) AS TenantId
         FROM lms.Tenant t
         LEFT JOIN lms.TenantBranding b ON b.TenantId = t.TenantId
        WHERE t.IsActive = 1`,
    );
    themes = rows.map(rowToTheme);
  } catch (e) {
    console.warn("[lib/tenant] DB load failed, using cached or neutral", e);
    themes = cache?.themes ?? [];
  }
  cache = { at: now, themes };
  return themes;
}

// "Learn.Example.com.:443", "[::1]:3000", "a.example.com, proxy.internal" → the
// bare, lower-case host a tenant row or the apex is compared with.
export function normHost(raw: string | null | undefined): string {
  let h = (raw ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  const v6 = /^\[([^\]]*)\]/.exec(h);
  h = v6 ? v6[1] ?? "" : h.split(":")[0] ?? "";
  return h.replace(/\.$/, "");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

// App Service sets WEBSITE_HOSTNAME to the app's (or slot's) default host.
export function appHosts(env: Record<string, string | undefined> = process.env): string[] {
  const hosts = [env.WEBSITE_HOSTNAME];
  if (env.AZURE_APP_NAME) hosts.push(`${env.AZURE_APP_NAME}.azurewebsites.net`);
  return hosts.map(normHost).filter(Boolean);
}

// null means the host belongs to no tenant. With no themes loaded (a fresh
// install, or a DB failure with nothing cached) every host gets NEUTRAL_THEME
// rather than a 404, so an outage never reads as "this site doesn't exist".
export function resolveThemeForHost(
  host: string | null,
  themes: TenantTheme[],
  options: { apex?: string; apexSlug?: string; appHosts?: string[] } = {},
): TenantTheme | null {
  const apex = normHost(options.apex ?? APEX);
  const apexSlug = (options.apexSlug ?? APEX_TENANT_SLUG).toLowerCase();
  const own = options.appHosts ?? appHosts();
  if (themes.length === 0) return NEUTRAL_THEME;
  const bySlug = (slug: string) => themes.find((t) => t.slug.trim().toLowerCase() === slug);
  const apexTheme = () => bySlug(apexSlug) ?? NEUTRAL_THEME;

  const bare = normHost(host);
  if (!bare) return apexTheme();
  const byCustom = themes.find((t) => t.domain && normHost(t.domain) === bare);
  if (byCustom) return byCustom;
  if (bare === apex || bare === `www.${apex}` || LOCAL_HOSTS.has(bare) || own.includes(bare)) {
    return apexTheme();
  }
  if (bare.endsWith(`.${apex}`)) {
    const sub = bare.slice(0, bare.length - apex.length - 1);
    return bySlug(sub) ?? null;
  }
  return null;
}

// Loads a tenant theme by slug without needing a request context. Used by
// cron endpoints and other server-side jobs that have no incoming Host header.
export async function getThemeForSlug(slug: string): Promise<TenantTheme | null> {
  const themes = await loadThemes();
  return (
    themes.find((t) => t.slug.toLowerCase() === slug.toLowerCase()) ?? null
  );
}

// Throws Next's 404 for a host that belongs to no tenant.
export function themeForHeaders(
  h: Pick<Headers, "get"> | null,
  themes: TenantTheme[],
  options?: Parameters<typeof resolveThemeForHost>[2],
  env: Record<string, string | undefined> = process.env,
): TenantTheme {
  const host = h ? requestHost(h, env) : null;
  const theme = resolveThemeForHost(host, themes, options);
  if (!theme) notFound();
  return theme;
}

export async function getThemeForRequest(): Promise<TenantTheme> {
  let h: Awaited<ReturnType<typeof headers>> | null = null;
  try {
    h = await headers();
  } catch {
    // Outside a request scope (build-time) — fall through to apex tenant.
  }
  return themeForHeaders(h, await loadThemes());
}

export function _resetTenantThemeCache(): void {
  cache = null;
}
