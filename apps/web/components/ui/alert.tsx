// Alert primitive — the consistent inline callout for warnings, errors, and
// notices that were previously hand-rolled per page (e.g. the amber
// `border-amber-300 bg-amber-50 …` boxes on finance forms). Tones map to the
// semantic palette (CLAUDE.md §4). Use `role="alert"` tone for errors so
// screen readers announce them (CLAUDE.md §28).

import type { ReactNode } from 'react'

import { cn } from '@/lib/cn'

import {
  AlertTriangleIcon,
  CheckCircleIcon,
  InboxIcon,
  XCircleIcon,
} from './icon'

type AlertTone = 'info' | 'warn' | 'danger' | 'success'

const TONES: Record<AlertTone, string> = {
  info: 'border-primary-200 bg-primary-50 text-primary-900',
  warn: 'border-amber-200 bg-amber-50 text-amber-900',
  danger: 'border-red-200 bg-red-50 text-red-800',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
}

const ICONS: Record<AlertTone, typeof InboxIcon> = {
  info: InboxIcon,
  warn: AlertTriangleIcon,
  danger: XCircleIcon,
  success: CheckCircleIcon,
}

interface AlertProps {
  tone?: AlertTone
  title?: ReactNode
  children?: ReactNode
  /** Hide the leading tone icon. */
  hideIcon?: boolean
  className?: string
}

export function Alert({
  tone = 'info',
  title,
  children,
  hideIcon = false,
  className,
}: AlertProps) {
  const Icon = ICONS[tone]
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex gap-2.5 rounded-lg border px-3 py-2.5 text-sm',
        TONES[tone],
        className,
      )}
    >
      {!hideIcon && <Icon size={16} className="mt-0.5 flex-none" aria-hidden />}
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && (
          <div className={cn(title && 'mt-0.5', 'text-[13px] opacity-90')}>
            {children}
          </div>
        )}
      </div>
    </div>
  )
}
