// Badge primitive. Used everywhere we need a small status pill: roles,
// task status, payment state, channel, etc. CLAUDE.md §4 (semantic colours).

import type { ReactNode } from 'react'

export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warn'
  | 'danger'
  | 'accent'

interface Props {
  tone?: BadgeTone
  children: ReactNode
  className?: string
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700',
  info: 'bg-primary-50 text-primary-700',
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  accent: 'bg-violet-50 text-violet-700',
}

export function Badge({ tone = 'neutral', children, className = '' }: Props) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {children}
    </span>
  )
}
