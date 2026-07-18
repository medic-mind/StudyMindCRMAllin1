// Badge primitive. Used everywhere we need a small status pill: roles,
// task status, payment state, channel, etc. CLAUDE.md §4 (semantic colours).
//
// Pass `dot` for a status-style pill with a tonal indicator dot. The dot
// shape (Linear/Attio-style) is the right read for true status; leave it
// off for purely categorical labels.

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
  dot?: boolean
  /** Optional native tooltip (e.g. an explanation of a status pill). */
  title?: string
}

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-700',
  info: 'bg-primary-50 text-primary-700',
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-800',
  danger: 'bg-red-50 text-red-700',
  accent: 'bg-violet-50 text-violet-700',
}

const DOTS: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-400',
  info: 'bg-primary-500',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-red-500',
  accent: 'bg-violet-500',
}

export function Badge({ tone = 'neutral', children, className = '', dot = false, title }: Props) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONES[tone]} ${className}`}
    >
      {dot ? (
        <span aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${DOTS[tone]}`} />
      ) : null}
      {children}
    </span>
  )
}
