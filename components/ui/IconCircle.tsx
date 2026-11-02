import { ReactNode } from 'react'
import { brandAccentTint } from './tokens'

interface IconCircleProps {
  children: ReactNode
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

export function IconCircle({ children, size = 'md', className = '' }: IconCircleProps) {
  const sizeClasses = { sm: 'w-10 h-10', md: 'w-14 h-14', lg: 'w-20 h-20' }
  return (
    <div className={`${sizeClasses[size]} rounded-full flex items-center justify-center ${className}`} style={{ backgroundColor: brandAccentTint(20) }}>
      {children}
    </div>
  )
}
