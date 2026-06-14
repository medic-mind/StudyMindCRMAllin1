// KPI tile used on the dashboard. A large value, label, a tone-tinted icon
// chip, and an optional delta vs the trailing 7d window. When an `href` is
// given the whole tile becomes a link that lifts on hover and reveals a "view"
// chevron. CLAUDE.md §4 (brand identity, tinted accents), §28 (deltas announced
// via aria-label; motion is gentle + reduced-motion-safe).

import Link from 'next/link'
import type { ReactNode } from 'react'

import { ChevronRightIcon } from '@/components/ui/icon'

export type KpiTone = 'neutral' | 'success' | 'warn' | 'danger' | 'info'

interface Props {
  label: string
  value: number | string
  delta?: number | null
  /**
   * If a delta is present, controls how positive deltas render:
   * - `up_is_good`: positive delta is success-coloured (e.g. active families).
   * - `up_is_bad`: positive delta is warn-coloured (e.g. open discrepancies).
   * - `neutral`: never coloured.
   */
  deltaSemantics?: 'up_is_good' | 'up_is_bad' | 'neutral'
  tone?: KpiTone
  icon?: ReactNode
  hint?: string
  /** When set, the whole tile links here. */
  href?: string
}

// Tone-tinted icon chip (soft fill + inset ring) — gives each tile a flash of
// identity without colouring the value, which stays high-contrast neutral.
const TONE_ACCENT: Record<KpiTone, string> = {
  neutral: 'bg-neutral-100 text-neutral-500 ring-neutral-200',
  success: 'bg-emerald-50 text-emerald-600 ring-emerald-100',
  warn: 'bg-amber-50 text-amber-600 ring-amber-100',
  danger: 'bg-rose-50 text-rose-600 ring-rose-100',
  info: 'bg-primary-50 text-primary-600 ring-primary-100',
}

export function KpiTile({
  label,
  value,
  delta,
  deltaSemantics = 'neutral',
  tone = 'neutral',
  icon,
  hint,
  href,
}: Props) {
  const renderDelta = () => {
    if (delta == null) return null
    if (delta === 0) {
      return (
        <span
          className="text-xs font-medium text-neutral-500"
          aria-label="no change in the last 7 days"
        >
          0 vs 7d
        </span>
      )
    }
    const sign = delta > 0 ? '+' : ''
    const positive = delta > 0
    const good =
      (deltaSemantics === 'up_is_good' && positive) ||
      (deltaSemantics === 'up_is_bad' && !positive)
    const bad =
      (deltaSemantics === 'up_is_bad' && positive) ||
      (deltaSemantics === 'up_is_good' && !positive)
    const cls = good ? 'text-emerald-700' : bad ? 'text-amber-700' : 'text-neutral-500'
    return (
      <span
        className={`text-xs font-medium ${cls}`}
        aria-label={`${positive ? 'up' : 'down'} ${Math.abs(delta)} in the last 7 days`}
      >
        {sign}
        {delta} vs 7d
      </span>
    )
  }

  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-neutral-500">
            {label}
          </p>
          <p className="mt-2.5 font-mono text-[2rem] font-semibold leading-none tabular-nums text-neutral-900">
            {value}
          </p>
        </div>
        {icon ? (
          <span
            aria-hidden="true"
            className={`flex h-10 w-10 items-center justify-center rounded-xl ring-1 ring-inset ${TONE_ACCENT[tone]}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-3.5 flex items-center justify-between gap-2">
        {hint ? <p className="truncate text-xs text-neutral-500">{hint}</p> : <span />}
        {delta != null ? (
          renderDelta()
        ) : href ? (
          <span
            aria-hidden="true"
            className="flex items-center text-xs font-medium text-neutral-400 transition-colors group-hover:text-primary-700"
          >
            View
            <ChevronRightIcon
              size={14}
              className="transition-transform group-hover:translate-x-0.5"
            />
          </span>
        ) : null}
      </div>
    </>
  )

  const base =
    'group relative block overflow-hidden rounded-2xl border border-neutral-200 bg-white p-5 shadow-card transition-all duration-200'
  const interactive =
    'hover:-translate-y-0.5 hover:border-neutral-300 hover:shadow-card-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2'

  if (href) {
    return (
      <Link href={href} className={`${base} ${interactive}`}>
        {body}
      </Link>
    )
  }
  return <div className={base}>{body}</div>
}
