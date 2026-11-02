import { forwardRef } from 'react'
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, CSSProperties, ForwardedRef, ReactNode, RefAttributes, ReactElement, SyntheticEvent } from 'react'
import { CONTROL_COLORS, CONTROL_STATES, controlGeometry } from '@/tailwind/control-metrics'
import type { ControlDensity, ControlSurface, ControlTargetSize } from '@/tailwind/control-metrics'
import {
  AI_VIOLET_SURFACE, BRAND_ACCENT, BRAND_ON_ACCENT, BRAND_ON_PRIMARY, BRAND_PRIMARY, BRAND_PRIMARY_ON_WHITE,
  DARK_BRAND_BORDER, DARK_BRAND_INK, DARK_FG, DARK_HOVER_SURFACE_MUTED,
} from './tokens'

// lucide-react's Loader2, inlined so the app carries no icon package.
function Loader2({ className }: { className: string }) {
  return <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>
}

export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'danger' | 'ghost' | 'ai' | 'choice'
/** Choice appearance only; the caller retains selection and keyboard behavior. */
export type ButtonSelectionTone = 'brand' | 'neutral'
/** Typography only: every size retains the canonical physical target and padding. */
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

interface ButtonAppearance {
  children: ReactNode
  variant?: ButtonVariant
  size?: ButtonSize
  /** Compact visual padding retains the same accessible physical target. */
  density?: ControlDensity
  surface?: ControlSurface
  targetSize?: ControlTargetSize
  /** For choice controls: style caller-supplied aria-pressed/selected/current. */
  selectionTone?: ButtonSelectionTone
  disabled?: boolean
  /** Show a leading spinner and disable activation. */
  loading?: boolean
}

export type ButtonNativeProps = ButtonAppearance & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonAppearance> & { href?: undefined }
export type ButtonLinkProps = ButtonAppearance & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonAppearance> & { href: string }
export type ButtonProps = ButtonNativeProps | ButtonLinkProps

const typography: Record<ButtonSize, string> = {
  xs: 'text-xs', sm: 'text-sm', md: 'text-base', lg: 'text-lg',
}
const spinner: Record<ButtonSize, string> = {
  xs: 'h-3 w-3', sm: 'h-4 w-4', md: 'h-4 w-4', lg: 'h-5 w-5',
}

interface ButtonComponent {
  (props: ButtonLinkProps & RefAttributes<HTMLAnchorElement>): ReactElement | null
  (props: ButtonNativeProps & RefAttributes<HTMLButtonElement>): ReactElement | null
  displayName?: string
}

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button({
  children, variant = 'primary', size = 'md', density = 'standard', surface = 'page', targetSize = 'standard',
  selectionTone = 'neutral', className = '', style, disabled = false, loading = false, ...nativeProps
}, ref) {
  const geometry = controlGeometry(surface, targetSize, density)
  const navy = surface === 'navy'
  const isDisabled = disabled || loading
  const variantClasses: Record<ButtonVariant, string> = {
    primary: 'hover:opacity-90',
    secondary: 'text-white hover:opacity-90',
    outline: navy ? 'hover:opacity-80' : `hover:opacity-80 ${DARK_BRAND_INK} ${DARK_BRAND_BORDER}`,
    danger: '[:is(.dark,[data-theme=dark])_&]:!bg-[color:var(--forit-control-danger-fill-dark)] [:is(.dark,[data-theme=dark])_&]:!text-[color:var(--forit-control-danger-ink-dark)]',
    ghost: navy ? 'text-white hover:opacity-80' : `text-slate-700 hover:bg-slate-100 ${DARK_FG} ${DARK_HOVER_SURFACE_MUTED}`,
    ai: AI_VIOLET_SURFACE,
    choice: 'btn-choice',
  }
  const variantStyles: Partial<Record<ButtonVariant, CSSProperties>> = {
    primary: navy ? { backgroundColor: 'white', color: BRAND_PRIMARY_ON_WHITE } : { backgroundColor: BRAND_PRIMARY, color: BRAND_ON_PRIMARY },
    // Keep the established web accent-filled role. Native secondary maps to outline.
    secondary: { backgroundColor: BRAND_ACCENT, color: BRAND_ON_ACCENT },
    outline: { borderColor: navy ? 'white' : BRAND_PRIMARY, color: navy ? 'white' : BRAND_PRIMARY },
    ghost: navy ? { color: 'white', backgroundColor: 'transparent' } : undefined,
    danger: {
      backgroundColor: navy ? CONTROL_COLORS.destructive.navy.fill : CONTROL_COLORS.destructive.light.fill,
      color: navy ? CONTROL_COLORS.destructive.navy.ink : CONTROL_COLORS.destructive.light.ink,
    },
    // The shared preset owns both tones and the caller's ARIA-driven paint.
    // Variables keep that one authority while overriding caller paint styles.
    choice: {
      backgroundColor: 'var(--forit-choice-fill, transparent)',
      color: 'var(--forit-choice-ink, inherit)',
      borderColor: 'var(--forit-choice-stroke, transparent)',
    },
  }
  // Caller layout styles survive; geometry always comes from the generated manifest.
  const styles: CSSProperties & { cornerShape?: string; [key: `--${string}`]: string | number } = {
    ...style,
    '--forit-control-pressed-opacity': CONTROL_STATES.pressedOpacity,
    '--forit-control-disabled-opacity': CONTROL_STATES.disabledOpacity,
    ...(variant === 'danger' ? {
      '--forit-control-danger-fill-dark': CONTROL_COLORS.destructive.dark.fill,
      '--forit-control-danger-ink-dark': CONTROL_COLORS.destructive.dark.ink,
    } : {}),
    boxSizing: 'border-box',
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    minWidth: geometry.minimumTarget,
    minHeight: geometry.minimumTarget,
    padding: `${geometry.verticalPadding}px ${geometry.horizontalPadding}px`,
    borderWidth: geometry.outlineWidth,
    borderStyle: 'solid',
    borderColor: 'transparent',
    borderRadius: geometry.cornerRadius,
    // One 14px continuous corner on every surface; unsupported browsers keep it rounded.
    cornerShape: geometry.cssCornerShape,
    gap: geometry.actionSpacing,
    ...(isDisabled ? { opacity: CONTROL_STATES.disabledOpacity } : {}),
    ...variantStyles[variant],
  }
  const stateClasses = isDisabled
    ? '!opacity-[var(--forit-control-disabled-opacity)] cursor-not-allowed'
    : 'active:!opacity-[var(--forit-control-pressed-opacity)]'
  const appearanceClasses = isDisabled
    ? variantClasses[variant].split(' ').filter(token => !token.includes('hover:')).join(' ')
    : variantClasses[variant]
  const classes = `forit-control-focus inline-flex items-center justify-center font-semibold transition-colors duration-200 ${stateClasses} ${appearanceClasses} ${typography[size]} ${className}`
  const content = <>{loading && <Loader2 className={`${spinner[size]} animate-spin shrink-0`} />}{children}</>

  if (typeof nativeProps.href === 'string') {
    const { href, onClick, onClickCapture, onAuxClick, onKeyDown, onKeyDownCapture, onKeyUp, onPointerDown, tabIndex, ...linkProps } = nativeProps as Omit<ButtonLinkProps, keyof ButtonAppearance>
    const guarded = <E extends SyntheticEvent<HTMLAnchorElement>>(handler?: (event: E) => void) => (event: E) => {
      if (isDisabled) {
        event.preventDefault()
        event.stopPropagation()
        return
      }
      handler?.(event)
    }
    const guardedKey = (handler?: React.KeyboardEventHandler<HTMLAnchorElement>): React.KeyboardEventHandler<HTMLAnchorElement> => (event) => {
      if (isDisabled) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
        }
        return
      }
      handler?.(event)
    }
    return <a
      {...linkProps}
      ref={ref as ForwardedRef<HTMLAnchorElement>}
      href={isDisabled ? undefined : href}
      role={linkProps.role ?? (isDisabled ? 'link' : undefined)}
      data-forit-control-surface={surface}
      data-forit-control-target-size={targetSize}
      data-forit-control-density={density}
      data-forit-control-selection-tone={variant === 'choice' ? selectionTone : undefined}
      className={classes}
      style={styles}
      aria-disabled={isDisabled || linkProps['aria-disabled'] || undefined}
      aria-busy={loading || linkProps['aria-busy'] || undefined}
      tabIndex={isDisabled ? -1 : tabIndex}
      onClick={guarded(onClick)}
      onClickCapture={guarded(onClickCapture)}
      onAuxClick={guarded(onAuxClick)}
      onKeyDown={guardedKey(onKeyDown)}
      onKeyDownCapture={guardedKey(onKeyDownCapture)}
      onKeyUp={guardedKey(onKeyUp)}
      onPointerDown={guarded(onPointerDown)}
    >{content}</a>
  }

  const { href: _href, type = 'button', ...buttonProps } = nativeProps as Omit<ButtonNativeProps, keyof ButtonAppearance>
  return <button
    {...buttonProps}
    ref={ref as ForwardedRef<HTMLButtonElement>}
    type={type}
    data-forit-control-surface={surface}
    data-forit-control-target-size={targetSize}
    data-forit-control-density={density}
    data-forit-control-selection-tone={variant === 'choice' ? selectionTone : undefined}
    className={classes}
    style={styles}
    disabled={isDisabled}
    aria-busy={loading || buttonProps['aria-busy'] || undefined}
  >{content}</button>
}) as ButtonComponent

Button.displayName = 'Button'
