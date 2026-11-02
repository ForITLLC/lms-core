// Brand colours: the tenant's --brand-* variable from app/layout.tsx
// (lib/theme.ts themeToCssVars), falling back to the neutral slate of
// NEUTRAL_THEME, never ForIT's palette. lib/theme.test.ts holds them equal.
export const BRAND_PRIMARY = 'var(--brand-primary, #475569)'
export const BRAND_ON_PRIMARY = 'var(--brand-on-primary, #FFFFFF)'
export const BRAND_PRIMARY_ON_WHITE = `var(--brand-primary-on-white, ${BRAND_PRIMARY})`
export const BRAND_ACCENT = 'var(--brand-accent, #94A3B8)'
export const BRAND_ON_ACCENT = `var(--brand-on-accent, ${BRAND_PRIMARY})`
export const BRAND_DARK = 'var(--brand-dark, #1E293B)'

export function brandAccentTint(percent: number): string {
  return `color-mix(in srgb, ${BRAND_ACCENT} ${percent}%, transparent)`
}

// Dark-mode chrome, applied when <html> carries class="dark" or
// data-theme="dark". The :is() lifts the selector to (0,2,0) so it beats the
// light class without `dark:`. Static literals only: Tailwind finds classes by
// scanning this text, so a class built at run time never reaches the stylesheet.
export const DARK_SURFACE = '[:is(.dark,[data-theme=dark])_&]:bg-[var(--forit-surface,#121212)]'
export const DARK_SURFACE_MUTED = '[:is(.dark,[data-theme=dark])_&]:bg-[var(--forit-surface-muted,#262626)]'
export const DARK_HOVER_SURFACE_MUTED = '[:is(.dark,[data-theme=dark])_&]:hover:bg-[var(--forit-surface-muted,#262626)]'
export const DARK_LINE = '[:is(.dark,[data-theme=dark])_&]:border-[color:var(--forit-line,#2E2E2E)]'
export const DARK_HOVER_LINE_STRONG = '[:is(.dark,[data-theme=dark])_&]:hover:border-[color:var(--forit-line-strong,#3D3D3D)]'
export const DARK_FG = '[:is(.dark,[data-theme=dark])_&]:text-[color:var(--forit-fg,#F5F5F5)]'
export const DARK_FG_MUTED = '[:is(.dark,[data-theme=dark])_&]:text-[color:var(--forit-fg-muted,#A3A3A3)]'
// Brand ink turns to the accent in dark, because a dark primary vanishes on
// black. It carries `!` because the light colour is an inline style.
export const DARK_BRAND_INK = '[:is(.dark,[data-theme=dark])_&]:!text-[color:var(--brand-accent,#94A3B8)]'
export const DARK_BRAND_BORDER = '[:is(.dark,[data-theme=dark])_&]:!border-[color:var(--brand-accent,#94A3B8)]'

export const DARK_BADGE = {
  success: '[:is(.dark,[data-theme=dark])_&]:bg-green-500/15 [:is(.dark,[data-theme=dark])_&]:text-green-300',
  warning: '[:is(.dark,[data-theme=dark])_&]:bg-yellow-500/15 [:is(.dark,[data-theme=dark])_&]:text-yellow-300',
  error: '[:is(.dark,[data-theme=dark])_&]:bg-red-500/15 [:is(.dark,[data-theme=dark])_&]:text-red-300',
  info: '[:is(.dark,[data-theme=dark])_&]:bg-blue-500/15 [:is(.dark,[data-theme=dark])_&]:text-blue-300',
  neutral: `${DARK_SURFACE_MUTED} ${DARK_FG}`,
} as const

export const AI_VIOLET_SURFACE =
  'border border-violet-300 bg-white text-violet-700 shadow-sm ' +
  'hover:border-violet-400 hover:bg-violet-50'
