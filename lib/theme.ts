// A tenant's theme, built from its lms.TenantBranding row by lib/tenant.ts.
// The field names match the TenantBranding shape the other ForIT apps use.
export interface TenantTheme {
  tenant_id: string;
  slug: string;
  name: string;
  domain?: string;
  aad_tenant_id?: string;
  company_name: string;
  logo_url?: string;
  logo_white_url?: string;
  favicon_url?: string;
  primary_color: string;
  secondary_color: string;
  accent_color: string;
  font_family: string;
  support_email?: string;
  support_phone?: string;
  welcome_text?: string;
  portal_welcome_text?: string;
  custom_css?: string;
  email_sender?: { address: string; display_name: string };
}

// Slate grey that names no organisation: what a host shows when it resolves no
// tenant, and the fill for a column a tenant row leaves empty. Never ForIT's brand.
export const NEUTRAL_THEME: TenantTheme = {
  tenant_id: "00000000-0000-0000-0000-000000000000",
  slug: "neutral",
  name: "Learning",
  company_name: "Learning",
  primary_color: "#475569",
  secondary_color: "#1E293B",
  accent_color: "#94A3B8",
  font_family: "Inter, system-ui, sans-serif",
};

// WCAG relative luminance of an opaque #rgb or #rrggbb colour; anything else
// (a CSS variable, alpha, a named colour) is unknown, never assumed black.
function relativeLuminance(color: unknown): number | null {
  if (typeof color !== "string") return null;
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!;
  const channel = (offset: number): number => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

export function contrastRatio(first: unknown, second: unknown): number | null {
  const a = relativeLuminance(first);
  const b = relativeLuminance(second);
  if (a === null || b === null) return null;
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Black or white text, whichever reads better on the tenant's primary fill.
function inkOnFill(fill: string): "#000000" | "#FFFFFF" | null {
  const black = contrastRatio(fill, "#000000");
  const white = contrastRatio(fill, "#FFFFFF");
  if (black === null || white === null) return null;
  return black > white ? "#000000" : "#FFFFFF";
}

// The tenant's primary as text on white when it reaches 4.5:1, otherwise black.
function primaryOnWhite(primary: string): string | null {
  const ratio = contrastRatio(primary, "#FFFFFF");
  return ratio === null ? null : ratio >= 4.5 ? primary : "#000000";
}

// The stylesheet app/layout.tsx puts in <head>: the --brand-* variables that
// themePreset's colours read, then the tenant's own CSS. An ink variable is
// left out when its colour can't be measured, so the class falls back rather
// than guessing.
export function themeToCssVars(theme: TenantTheme): string {
  const onPrimary = inkOnFill(theme.primary_color);
  const inkOnWhite = primaryOnWhite(theme.primary_color);
  const accentContrast = contrastRatio(theme.primary_color, theme.accent_color);
  const onAccent = accentContrast !== null && accentContrast >= 4.5 ? theme.primary_color : inkOnFill(theme.accent_color);
  const lines = [
    `--brand-primary: ${theme.primary_color};`,
    ...(onPrimary === null ? [] : [`--brand-on-primary: ${onPrimary};`]),
    ...(inkOnWhite === null ? [] : [`--brand-primary-on-white: ${inkOnWhite};`]),
    `--brand-secondary: ${theme.secondary_color};`,
    `--brand-accent: ${theme.accent_color};`,
    ...(onAccent === null ? [] : [`--brand-on-accent: ${onAccent};`]),
    `--brand-dark: ${theme.secondary_color};`,
    `--brand-light: ${theme.accent_color};`,
    `--brand-surface: #F1F5F9;`,
    `--brand-font: ${theme.font_family};`,
  ];
  const root = `:root { ${lines.join(" ")} } .dark { --brand-surface: #121212; } body { font-family: var(--brand-font); }`;
  return theme.custom_css ? `${root}\n${theme.custom_css}` : root;
}

export interface EmailBranding {
  name: string;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  supportEmail?: string;
  supportPhone?: string;
}

export function themeToBranding(theme: TenantTheme): EmailBranding {
  return {
    name: theme.company_name,
    primaryColor: theme.primary_color,
    secondaryColor: theme.secondary_color,
    accentColor: theme.accent_color,
    supportEmail: theme.support_email,
    supportPhone: theme.support_phone,
  };
}

// Tailwind colours over the variables above. A fallback only shows when the
// stylesheet is missing, so it is the neutral slate, not any tenant's colour.
export const themePreset = {
  theme: {
    extend: {
      colors: {
        "brand-primary": `var(--brand-primary, ${NEUTRAL_THEME.primary_color})`,
        "brand-on-primary": "var(--brand-on-primary)",
        "brand-primary-on-white": "var(--brand-primary-on-white)",
        "brand-secondary": `var(--brand-secondary, ${NEUTRAL_THEME.secondary_color})`,
        "brand-accent": `var(--brand-accent, ${NEUTRAL_THEME.accent_color})`,
        "brand-on-accent": "var(--brand-on-accent)",
        "brand-dark": `var(--brand-dark, ${NEUTRAL_THEME.secondary_color})`,
        "brand-light": `var(--brand-light, ${NEUTRAL_THEME.accent_color})`,
        "brand-surface": "var(--brand-surface, #F1F5F9)",
      },
      fontFamily: {
        brand: ["var(--brand-font, Inter)", "system-ui", "sans-serif"],
      },
    },
  },
};
