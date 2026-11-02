import type { Config } from 'tailwindcss'
import { CONTROL_COLORS, CONTROL_METRICS, CONTROL_STATES, controlGeometry } from './control-metrics'
import {
  FORIT_DARK_PALETTE,
  FORIT_LIGHT_PALETTE,
  foritPaletteColors,
  foritPaletteVars,
} from './dark-palette'

/**
 * The app's Tailwind preset (tailwind.config.ts): the --forit-* light and dark
 * palette and the control primitives (.btn-*, .card, form fields). Brand
 * colours read the tenant's --brand-* variables that app/layout.tsx sets,
 * never a fixed hex.
 *
 * This folder sits outside Tailwind's `content` globs on purpose. Tailwind
 * emits a component class only when it finds the name in scanned files, so
 * scanning this one would emit every .btn-* and .card rule whether a page uses
 * it or not.
 */

/** Minimal structural type for the slice of Tailwind's plugin API we use.
 *  Declared locally so the preset doesn't depend on `tailwindcss/plugin`'s
 *  module-resolution surface under NodeNext — a bare function is a valid
 *  Tailwind `PluginCreator`, and the full `PluginAPI` Tailwind passes in is
 *  structurally assignable to this narrower shape. */
type AddComponents = (components: Record<string, any>) => void
type PluginApi = {
  addComponents: AddComponents
  addBase: (base: Record<string, any>) => void
  config: (path: string) => unknown
}

const selectedChoice = (prefix = '&') => [
  '[aria-pressed="true"]', '[aria-selected="true"]',
  '[aria-current]:not([aria-current="false"]):not([aria-current=""])',
].map(state => `${prefix}${state}`).join(', ')

// One CSS source for both plain primitives and React's opt-in helper class.
// The backing separates the outline from a filled control; forced colours
// retain the system's own visible outline without relying on a box shadow.
const controlFocus = {
  '&:focus-visible': {
    outline: '2px solid var(--forit-control-fg) !important',
    outlineOffset: '3px !important',
    boxShadow: '0 0 0 3px var(--forit-control-surface) !important',
    '@media (forced-colors: active)': { outlineColor: 'Highlight !important', boxShadow: 'none !important' },
  },
}

/**
 * Control primitives: the form and button layer (.btn-*, .card, fields).
 * Actions and native fields keep their generated target minimum at every width.
 * Brand colours come from the tenant's --brand-primary and --brand-accent
 * variables, never a fixed hex.
 */
const foritControlPrimitives = (api: PluginApi): void => {
  // Control skins follow explicit user theme boundaries even in an app whose
  // legacy global palette follows OS media. Do not repaint that host document.
  const neutralVars = (palette: typeof FORIT_LIGHT_PALETTE, dark: boolean) => ({
    ...Object.fromEntries(Object.entries(foritPaletteVars(palette)).map(([key, value]) => [key.replace('--forit-', '--forit-control-'), value])),
    '--forit-control-invalid': dark ? CONTROL_COLORS.destructive.dark.fill : CONTROL_COLORS.destructive.light.fill,
    '--forit-control-stroke': palette.fgMuted,
    '--forit-control-color-scheme': dark ? 'dark' : 'light',
  })
  const configured = foritDarkSelector(api.config('darkMode'))
  const darkSelectors = [...new Set(['[class~="dark"]', '[data-theme="dark"]', ...(configured ? [alwaysEmitted(configured)] : [])])]
  api.addBase({
    // Keep defaults at the same specificity as explicit boundaries, including
    // when the boundary is the root element itself. A bare :root would win.
    ':where(:root)': neutralVars(FORIT_LIGHT_PALETTE, false),
    [`:where(${darkSelectors.join(', ')})`]: neutralVars(FORIT_DARK_PALETTE, true),
    ':where([data-theme="light"])': neutralVars(FORIT_LIGHT_PALETTE, false),
  })
  const geometry = (surface: 'page' | 'navy', target: 'standard' | 'spatial' = 'standard') => {
    const g = controlGeometry(surface, target)
    return {
      minHeight: `${g.minimumTarget}px`,
      minWidth: `${g.minimumTarget}px`,
      borderRadius: `${g.cornerRadius}px`,
      // Supported browsers render the native continuous-corner intent; other
      // browsers keep the same 14px radius with their rounded profile.
      cornerShape: g.cssCornerShape,
    }
  }
  const base = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxSizing: 'border-box',
    ...geometry('page'),
    paddingLeft: `${CONTROL_METRICS.horizontalPadding}px`,
    paddingRight: `${CONTROL_METRICS.horizontalPadding}px`,
    paddingTop: `${CONTROL_METRICS.verticalPadding}px`,
    paddingBottom: `${CONTROL_METRICS.verticalPadding}px`,
    borderWidth: `${CONTROL_METRICS.outlineWidth}px`,
    borderStyle: 'solid',
    borderColor: 'transparent',
    fontWeight: '600',
    fontFamily: 'inherit',
    fontSize: 'inherit',
    lineHeight: 'inherit',
    textDecoration: 'none',
    textAlign: 'center',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    transitionProperty: 'color, background-color, border-color, opacity',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
    transitionDuration: '150ms',
    ...controlFocus,
    '&:disabled, &[aria-disabled="true"]': { opacity: `${CONTROL_STATES.disabledOpacity}`, cursor: 'not-allowed' },
    '&:active:not(:disabled):not([aria-disabled="true"])': { opacity: `${CONTROL_STATES.pressedOpacity}` },
    '&[data-forit-control-density="compact"]': {
      paddingLeft: `${controlGeometry('page', 'standard', 'compact').horizontalPadding}px`,
      paddingRight: `${controlGeometry('page', 'standard', 'compact').horizontalPadding}px`,
      paddingTop: `${controlGeometry('page', 'standard', 'compact').verticalPadding}px`,
      paddingBottom: `${controlGeometry('page', 'standard', 'compact').verticalPadding}px`,
    },
    '&[data-forit-control-surface="navy"]': geometry('navy'),
    '&[data-forit-control-target-size="spatial"]': geometry('page', 'spatial'),
    '&[data-forit-control-surface="navy"][data-forit-control-target-size="spatial"]': geometry('navy', 'spatial'),
  }
  const navyPrimary = {
    ...geometry('navy'),
    backgroundColor: '#ffffff',
    color: 'var(--brand-primary-on-white,var(--brand-primary))',
  }
  const navyOutline = {
    ...geometry('navy'),
    backgroundColor: 'transparent',
    borderColor: '#ffffff',
    color: '#ffffff',
    '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: 'transparent', opacity: '0.8' },
  }
  api.addComponents({
    '.btn-primary': {
      ...base,
      color: 'var(--brand-on-primary,#ffffff)',
      backgroundColor: 'var(--brand-primary)',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { opacity: `${CONTROL_STATES.pressedOpacity}` },
      '&[data-forit-control-surface="navy"]': navyPrimary,
    },
    '.btn-secondary': {
      ...base,
      borderColor: '#d1d5db',
      backgroundColor: '#ffffff',
      color: '#374151',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: '#f9fafb' },
      '&[data-forit-control-surface="navy"]': navyOutline,
    },
    '.btn-outline': {
      ...base,
      backgroundColor: 'transparent',
      borderColor: 'var(--brand-primary)',
      color: 'var(--brand-primary)',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { opacity: '0.8' },
      '&[data-forit-control-surface="navy"]': navyOutline,
    },
    '.btn-danger': {
      ...base,
      backgroundColor: CONTROL_COLORS.destructive.light.fill,
      color: CONTROL_COLORS.destructive.light.ink,
      '&[data-forit-control-surface="navy"]': {
        ...geometry('navy'),
        backgroundColor: CONTROL_COLORS.destructive.navy.fill,
        color: CONTROL_COLORS.destructive.navy.ink,
      },
    },
    '.btn-ghost': {
      ...base,
      backgroundColor: 'transparent',
      color: '#334155',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: '#f1f5f9' },
      '&[data-forit-control-surface="navy"]': {
        ...geometry('navy'),
        color: '#ffffff',
        '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: 'transparent', opacity: '0.8' },
      },
    },
    '.btn-choice': {
      ...base,
      '--forit-choice-fill': 'transparent',
      '--forit-choice-ink': 'var(--forit-control-fg-muted)',
      '--forit-choice-stroke': 'var(--forit-control-stroke)',
      backgroundColor: 'var(--forit-choice-fill,transparent)',
      color: 'var(--forit-choice-ink,inherit)',
      borderColor: 'var(--forit-choice-stroke,transparent)',
      [selectedChoice()]: {
        '--forit-choice-fill': 'var(--forit-control-surface-muted)',
        '--forit-choice-ink': 'var(--forit-control-fg)',
      },
      [selectedChoice('&[data-forit-control-selection-tone="brand"]')]: {
        '--forit-choice-fill': 'var(--brand-primary)',
        '--forit-choice-ink': 'var(--brand-on-primary,#ffffff)',
        '--forit-choice-stroke': 'var(--forit-control-stroke)',
      },
      '&[data-forit-control-surface="navy"]': {
        ...geometry('navy'),
        '--forit-choice-ink': '#ffffff',
        '--forit-choice-stroke': 'rgb(255 255 255 / 0.4)',
        [selectedChoice()]: { '--forit-choice-fill': 'rgb(255 255 255 / 0.15)', '--forit-choice-ink': '#ffffff' },
        [selectedChoice('&[data-forit-control-selection-tone="brand"]')]: {
          '--forit-choice-fill': '#ffffff',
          '--forit-choice-ink': 'var(--brand-primary-on-white,var(--brand-primary))',
        },
      },
    },
    '.forit-control-focus': controlFocus,
    '.btn-actions': {
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: `${CONTROL_METRICS.actionSpacing}px`,
    },
    '.card': {
      borderRadius: '0.75rem',
      borderWidth: '1px',
      borderColor: '#f3f4f6',
      backgroundColor: '#ffffff',
      padding: '1.5rem',
      boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
    },
    '.field-row': {
      minWidth: '0',
      maxWidth: '100%',
      flexWrap: 'wrap',
    },
    '.field-label': {
      marginBottom: '0.25rem',
      display: 'block',
      fontSize: '0.875rem',
      lineHeight: '1.25rem',
      fontWeight: '500',
      color: 'var(--forit-control-fg-muted)',
    },
    '.field-input': {
      display: 'block',
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '100%',
      minWidth: '0',
      minHeight: `${CONTROL_METRICS.minimumTarget}px`,
      borderRadius: `${CONTROL_METRICS.actionCornerRadius}px`,
      cornerShape: controlGeometry().cssCornerShape,
      borderWidth: `${CONTROL_METRICS.outlineWidth}px`,
      borderStyle: 'solid',
      borderColor: 'var(--forit-control-stroke)',
      paddingLeft: `${CONTROL_METRICS.fieldHorizontalPadding}px`,
      paddingRight: `${CONTROL_METRICS.fieldHorizontalPadding}px`,
      paddingTop: `${CONTROL_METRICS.fieldVerticalPadding}px`,
      paddingBottom: `${CONTROL_METRICS.fieldVerticalPadding}px`,
      fontFamily: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      color: 'var(--forit-control-fg)',
      WebkitTextFillColor: 'currentColor',
      backgroundColor: 'var(--forit-control-surface)',
      colorScheme: 'var(--forit-control-color-scheme)',
      ...controlFocus,
      '&[data-forit-control-target-size="spatial"]': { minHeight: `${CONTROL_METRICS.spatialMinimumTarget}px` },
      '&:disabled, &[aria-disabled="true"]': {
        color: 'var(--forit-control-fg-muted)',
        backgroundColor: 'var(--forit-control-surface-muted)',
        cursor: 'not-allowed',
      },
      '&[aria-invalid="true"]': { borderColor: 'var(--forit-control-invalid)' },
    },
    // Keep the long-standing class selector API. Native-specific chrome is
    // scoped separately so an existing field container needs no markup change.
    'input.field-input, select.field-input, textarea.field-input': {
      '&::placeholder': { color: 'var(--forit-control-fg-muted)', opacity: '1' },
      '& option, & optgroup': { color: 'inherit', backgroundColor: 'var(--forit-control-surface)' },
      // Keep native date editors inside the border box at large text sizes.
      // Native editing/picker/value behaviour remains untouched.
      '&::-webkit-datetime-edit': { minWidth: '0', maxWidth: '100%', padding: '0' },
    },
  })
}

/**
 * The selector an app's dark mode hangs on, from its own `darkMode` setting:
 * `'class'` / `'selector'` → `.dark`; `['class', sel]` / `['selector', sel]` →
 * `sel`. `null` for `'media'` (Tailwind's default) and `['variant', …]`.
 */
export function foritDarkSelector(darkMode: unknown): string | null {
  if (darkMode === 'class' || darkMode === 'selector') return '.dark'
  if (Array.isArray(darkMode) && (darkMode[0] === 'class' || darkMode[0] === 'selector')) {
    return typeof darkMode[1] === 'string' && darkMode[1] ? darkMode[1] : '.dark'
  }
  return null
}

/**
 * Tailwind v3 emits a plugin rule whose selector names a class only when that
 * class is in the app's `content`. `.dark` is usually added by a boot script
 * outside `content` (`public/theme-boot.js`), which would silently drop the
 * dark variables. `[class~="dark"]` matches the same elements at the same
 * specificity and names no class, so it is always emitted.
 */
function alwaysEmitted(sel: string): string {
  const m = /^\.(-?[A-Za-z_][\w-]*)$/.exec(sel)
  return m ? `[class~="${m[1]}"]` : sel
}

/**
 * True black dark mode (Ben, 2026-10-08). Always: the `--forit-*` palette
 * variables, light on `:root` and dark when the app is dark, so `bg-page`,
 * `bg-surface` and friends flip by themselves.
 *
 * Painting (the black body, `color-scheme: dark`, the dark control primitives)
 * happens ONLY in an app that declared a class or selector dark mode. `'media'`
 * is Tailwind's default, so it says nothing about whether an app was ever
 * designed for dark: painting its body black under an OS dark setting would put
 * light text on its white cards. A media-mode app opts in by using the tokens
 * (`bg-page text-fg` on its root). Every painting rule is wrapped in `:where()`
 * so it adds no specificity: the app's own utilities, `dark:` or not, still win.
 */
const foritDarkMode = (api: PluginApi): void => {
  const mode = api.config('darkMode')
  const configured = foritDarkSelector(mode)
  const sel = configured && alwaysEmitted(configured)
  const dark = foritPaletteVars(FORIT_DARK_PALETTE)
  const base: Record<string, any> = { ':root': foritPaletteVars(FORIT_LIGHT_PALETTE) }
  if (sel) {
    base[sel] = { ...dark, colorScheme: 'dark' }
    base[`:where(${sel}) body, body:where(${sel})`] = {
      backgroundColor: 'var(--forit-page)',
      color: 'var(--forit-fg)',
    }
  } else if (mode === undefined || mode === 'media' || mode === false) {
    base['@media (prefers-color-scheme: dark)'] = { ':root': dark }
  }
  api.addBase(base)
  if (!sel) return
  const w = `:where(${sel})`
  api.addComponents({
    [`${w} .card`]: {
      borderColor: 'var(--forit-line)',
      backgroundColor: 'var(--forit-surface)',
    },
    [`${w} .btn-secondary`]: {
      borderColor: 'var(--forit-line-strong)',
      backgroundColor: 'var(--forit-surface-raised)',
      color: 'var(--forit-fg)',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: 'var(--forit-surface-muted)' },
    },
    [`${w} .btn-outline`]: {
      borderColor: 'var(--brand-accent)',
      color: 'var(--brand-accent)',
    },
    [`${w} .btn-ghost`]: {
      color: 'var(--forit-fg)',
      '&:hover:not(:active):not(:disabled):not([aria-disabled="true"])': { backgroundColor: 'var(--forit-surface-muted)' },
    },
    [`${w} .btn-danger`]: {
      backgroundColor: CONTROL_COLORS.destructive.dark.fill,
      color: CONTROL_COLORS.destructive.dark.ink,
    },
  })
}

const foritPlugin = (api: PluginApi): void => {
  foritControlPrimitives(api)
  foritDarkMode(api)
}

const foritPreset: Partial<Config> = {
  theme: {
    extend: {
      colors: {
        ...foritPaletteColors(),
        'brand-on-primary': 'var(--brand-on-primary,#ffffff)',
        'brand-on-accent': 'var(--brand-on-accent)',
        'brand-primary-on-white': 'var(--brand-primary-on-white,var(--brand-primary))',
      },
    },
  },
  plugins: [foritPlugin],
}

export default foritPreset
