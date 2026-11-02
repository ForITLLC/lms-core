import type { TenantTheme } from "@/lib/theme";

// The tenant's name for the app chrome, or null when no tenant resolved. A white-label
// app never falls back to ForIT's name, so NEUTRAL_THEME names no organisation at all.
export function tenantDisplayName(
  theme: Pick<TenantTheme, "slug" | "company_name" | "name">,
): string | null {
  if (theme.slug === "neutral") return null;
  return theme.company_name || theme.name || null;
}

export function learningLabel(name: string | null, separator = " · "): string {
  return name ? `${name}${separator}Learning` : "Learning";
}
