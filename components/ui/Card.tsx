import { ReactNode } from 'react'
import { BRAND_DARK, BRAND_PRIMARY, DARK_LINE, DARK_SURFACE, brandAccentTint } from './tokens'

interface CardProps {
  children: ReactNode
  className?: string
  variant?: 'white' | 'blue' | 'gradient'
  padding?: 'sm' | 'md' | 'lg'
}

export function Card({ children, className = '', variant = 'white', padding = 'md' }: CardProps) {
  const baseClasses = 'rounded-2xl'
  const variantClasses = {
    white: `bg-white shadow-sm border border-gray-100 ${DARK_SURFACE} ${DARK_LINE}`,
    blue: `bg-white shadow-sm border border-gray-100 ${DARK_SURFACE} ${DARK_LINE}`,
    gradient: 'text-white',
  }
  const paddingClasses = { sm: 'p-4', md: 'p-6', lg: 'p-8' }
  const backgroundStyle = variant === 'blue'
    ? { backgroundColor: brandAccentTint(15) }
    : variant === 'gradient'
      ? { background: `linear-gradient(135deg, ${BRAND_PRIMARY}, ${BRAND_DARK})` }
      : {}

  return (
    <div className={`${baseClasses} ${variantClasses[variant]} ${paddingClasses[padding]} ${className}`} style={backgroundStyle}>
      {children}
    </div>
  )
}
