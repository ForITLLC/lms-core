import { DARK_BADGE } from './tokens'

interface StatusBadgeProps {
  status: string
  variant?: 'success' | 'warning' | 'error' | 'info' | 'neutral'
  size?: 'sm' | 'md'
}

export function StatusBadge({ status, variant = 'neutral', size = 'sm' }: StatusBadgeProps) {
  const colors = {
    success: `bg-green-100 text-green-800 ${DARK_BADGE.success}`,
    warning: `bg-yellow-100 text-yellow-800 ${DARK_BADGE.warning}`,
    error: `bg-red-100 text-red-800 ${DARK_BADGE.error}`,
    info: `bg-blue-100 text-blue-800 ${DARK_BADGE.info}`,
    neutral: `bg-gray-100 text-gray-800 ${DARK_BADGE.neutral}`,
  }
  const sizes = { sm: 'px-2 py-0.5 text-xs', md: 'px-3 py-1 text-sm' }
  return <span className={`inline-flex items-center rounded-full font-medium ${colors[variant]} ${sizes[size]}`}>{status}</span>
}
