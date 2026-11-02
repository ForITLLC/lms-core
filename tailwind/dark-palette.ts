/**
 * The shared ForIT light and dark palettes: true black dark (Ben, 2026-10-08,
 * "All apps need true black dark").
 *
 * Dark mode starts at `#000000` for the page and steps surfaces UP from it, so
 * a card, a menu and a muted well each read as one layer lighter than the
 * thing under them. Nothing in dark mode is grey-on-grey `#111827`/`#1f2937`
 * any more: the page is black, and only what sits on it is lifted.
 *
 * Each colour ships as two CSS variables, set by the preset's base styles:
 *   --forit-<token>      the hex, for raw CSS and arbitrary values
 *                        (`bg-[var(--forit-surface-raised,#1C1C1C)]`)
 *   --forit-<token>-rgb  space-separated channels, so the Tailwind colours
 *                        (`bg-page`, `bg-surface`, `text-fg-muted`, …) keep
 *                        opacity modifiers (`bg-surface/80`)
 *
 * The variables flip with the app's dark mode, so `bg-page` is white in light
 * and black in dark with no `dark:` prefix.
 */
export interface ForitPalette {
  /** The page background: the bottom layer. */
  page: string
  /** A card or panel on the page. */
  surface: string
  /** A menu, popover or dialog above a surface. */
  surfaceRaised: string
  /** A muted well, table header or hover fill. */
  surfaceMuted: string
  /** A hairline border or divider. */
  line: string
  /** A control border (inputs, secondary buttons). */
  lineStrong: string
  /** Body text. */
  fg: string
  /** Secondary text: labels, captions, metadata. */
  fgMuted: string
}

export const FORIT_LIGHT_PALETTE: Readonly<ForitPalette> = Object.freeze({
  page: '#FFFFFF',
  surface: '#FFFFFF',
  surfaceRaised: '#FFFFFF',
  surfaceMuted: '#F9FAFB',
  line: '#E5E7EB',
  lineStrong: '#D1D5DB',
  fg: '#111827',
  fgMuted: '#6B7280',
})

export const FORIT_DARK_PALETTE: Readonly<ForitPalette> = Object.freeze({
  page: '#000000',
  surface: '#121212',
  surfaceRaised: '#1C1C1C',
  surfaceMuted: '#262626',
  line: '#2E2E2E',
  lineStrong: '#3D3D3D',
  fg: '#F5F5F5',
  fgMuted: '#A3A3A3',
})

/** Palette key → CSS variable stem (`surfaceRaised` → `surface-raised`). */
export const FORIT_PALETTE_TOKENS: Readonly<Record<keyof ForitPalette, string>> = Object.freeze({
  page: 'page',
  surface: 'surface',
  surfaceRaised: 'surface-raised',
  surfaceMuted: 'surface-muted',
  line: 'line',
  lineStrong: 'line-strong',
  fg: 'fg',
  fgMuted: 'fg-muted',
})

function channels(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`[tailwind/dark-palette] palette colour must be #RRGGBB, got ${hex}`)
  const n = parseInt(m[1]!, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/** The `--forit-*` variable declarations for one palette. */
export function foritPaletteVars(palette: ForitPalette): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const key of Object.keys(FORIT_PALETTE_TOKENS) as Array<keyof ForitPalette>) {
    const stem = FORIT_PALETTE_TOKENS[key]
    vars[`--forit-${stem}`] = palette[key]
    vars[`--forit-${stem}-rgb`] = channels(palette[key])
  }
  return vars
}

/** Tailwind colours that read the variables, opacity modifiers included. */
export function foritPaletteColors(): Record<string, string> {
  const colors: Record<string, string> = {}
  for (const stem of Object.values(FORIT_PALETTE_TOKENS)) {
    colors[stem] = `rgb(var(--forit-${stem}-rgb) / <alpha-value>)`
  }
  return colors
}
