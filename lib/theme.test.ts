import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as tokens from "../components/ui/tokens";
import { contrastRatio, NEUTRAL_THEME, themePreset, themeToBranding, themeToCssVars, type TenantTheme } from "./theme";

const theme = (over: Partial<TenantTheme>): TenantTheme => ({ ...NEUTRAL_THEME, slug: "operator", ...over });

function topLevelRules(css: string): string[] {
  const selectors: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) selectors.push(css.slice(start, i).trim());
      depth++;
      assert.equal(depth, 1, `nested rule at ${i}: ${css}`);
    } else if (css[i] === "}") {
      depth--;
      start = i + 1;
    }
  }
  assert.equal(depth, 0);
  return selectors;
}

test("the stylesheet is three flat rules the browser applies as written", () => {
  assert.deepEqual(topLevelRules(themeToCssVars(theme({ primary_color: "#000080" }))), [":root", ".dark", "body"]);
});

test("each brand variable carries the tenant's colour", () => {
  const css = themeToCssVars(theme({ primary_color: "#000080", secondary_color: "#0b1f7a", accent_color: "#e67e22", font_family: "Georgia, serif" }));
  for (const line of ["--brand-primary: #000080;", "--brand-secondary: #0b1f7a;", "--brand-accent: #e67e22;", "--brand-dark: #0b1f7a;",
    "--brand-light: #e67e22;", "--brand-font: Georgia, serif;"]) assert.ok(css.includes(line), line);
});

test("ink on the primary fill is whichever of black and white reads better", () => {
  assert.match(themeToCssVars(theme({ primary_color: "#000080" })), /--brand-on-primary: #FFFFFF;/);
  assert.match(themeToCssVars(theme({ primary_color: "#FFD700" })), /--brand-on-primary: #000000;/);
});

test("the primary is kept as text on white only at 4.5:1 or better", () => {
  assert.match(themeToCssVars(theme({ primary_color: "#767676" })), /--brand-primary-on-white: #767676;/);
  assert.match(themeToCssVars(theme({ primary_color: "#777777" })), /--brand-primary-on-white: #000000;/);
});

test("the accent's ink is the primary when the two contrast, otherwise black or white", () => {
  assert.match(themeToCssVars(theme({ primary_color: "#000080", accent_color: "#e67e22" })), /--brand-on-accent: #000080;/);
  assert.match(themeToCssVars(theme({ primary_color: "#e67e22", accent_color: "#e67f22" })), /--brand-on-accent: #000000;/);
});

test("a colour that can't be measured gets no ink variable, never a guessed one", () => {
  const css = themeToCssVars(theme({ primary_color: "var(--x)", accent_color: "red" }));
  assert.match(css, /--brand-primary: var\(--x\);/);
  assert.doesNotMatch(css, /--brand-on-primary|--brand-primary-on-white|--brand-on-accent/);
  assert.equal(contrastRatio("#12345", "#fff"), null);
});

test("the tenant's own CSS comes after the variables", () => {
  const css = themeToCssVars(theme({ custom_css: ".hero { color: var(--brand-accent); }" }));
  assert.ok(css.endsWith("\n.hero { color: var(--brand-accent); }"));
});

test("neither the neutral theme nor the Tailwind fallbacks carry ForIT's name or colours", () => {
  const forit = /#142F43|#0A1A26|#8EDCEF|forit/i;
  assert.doesNotMatch(JSON.stringify(NEUTRAL_THEME), forit);
  assert.doesNotMatch(JSON.stringify(themePreset), forit);
  assert.equal(themePreset.theme.extend.colors["brand-primary"], `var(--brand-primary, ${NEUTRAL_THEME.primary_color})`);
});

const FORIT_PALETTE = /#(142F43|0A1A26|8EDCEF|E1EFF3|C4DFE8|5ECDE5|2EBDD8|1A8FAA|146E85|0F2333)\b/i;

test("the components and stylesheet sources fall back to the neutral slate, never ForIT's palette", () => {
  assert.equal(tokens.BRAND_PRIMARY, `var(--brand-primary, ${NEUTRAL_THEME.primary_color})`);
  assert.equal(tokens.BRAND_ACCENT, `var(--brand-accent, ${NEUTRAL_THEME.accent_color})`);
  assert.equal(tokens.BRAND_DARK, `var(--brand-dark, ${NEUTRAL_THEME.secondary_color})`);
  assert.ok(tokens.DARK_BRAND_INK.includes(`var(--brand-accent,${NEUTRAL_THEME.accent_color})`), tokens.DARK_BRAND_INK);
  assert.ok(tokens.DARK_BRAND_BORDER.includes(`var(--brand-accent,${NEUTRAL_THEME.accent_color})`), tokens.DARK_BRAND_BORDER);
  for (const file of ["../app/globals.css", "../components/ui/tokens.ts", "../tailwind/preset.ts", "../tailwind/control-metrics.ts", "../tailwind/dark-palette.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, FORIT_PALETTE, file);
    assert.doesNotMatch(source, /--(navy-blue|light-blue|light-gray|dark-blue)\b/, file);
  }
});

test("email branding takes the tenant's name, colours and support contacts", () => {
  assert.deepEqual(themeToBranding(theme({ company_name: "Operator Air", primary_color: "#000080", support_email: "help@operator.example" })), {
    name: "Operator Air", primaryColor: "#000080", secondaryColor: NEUTRAL_THEME.secondary_color, accentColor: NEUTRAL_THEME.accent_color,
    supportEmail: "help@operator.example", supportPhone: undefined,
  });
});
