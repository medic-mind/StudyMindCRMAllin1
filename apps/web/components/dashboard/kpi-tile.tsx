// KPI tile used on the dashboard. Large value, label, optional delta vs the
// trailing 7d window with a small tone indicator. When an `href` is given the
// whole tile becomes a link into the relevant workspace. CLAUDE.md §4 (warm
// secondary used sparingly), §28 (deltas announced via aria-label).

import Link from 'next/link'
import type { ReactNode } from 'react'

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

const TONE_BG: Record<KpiTone, string> = {
  neutral: 'bg-white',
  success: 'bg-white',
  warn: 'bg-white',
  danger: 'bg-white',
  info: 'bg-white',
}

const TONE_ACCENT: Record<KpiTone, string> = {
  neutral: 'text-neutral-500 bg-neutral-100',
  success: 'text-emerald-700 bg-emerald-50',
  warn: 'text-amber-700 bg-amber-50',
  danger: 'text-red-700 bg-red-50',
  info: 'text-primary-700 bg-primary-50',
}

// Left accent bar colour per tone — gives each tile a flash of identity
// instead of a uniform grey card.
const TONE_BAR: Record<KpiTone, string> = {
  neutral: 'bg-neutral-300',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  danger: 'bg-rose-500',
  info: 'bg-primary-500',
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
    const cls = good
      ? 'text-emerald-700'
      : bad
        ? 'text-amber-700'
        : 'text-neutral-500'
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
      <span
        aria-hidden="true"
        className={`absolute inset-y-0 left-0 w-1 ${TONE_BAR[tone]}`}
      />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-medium uppercase tracking-wide text-neutral-500">
            {label}
          </p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums text-neutral-900">
            {value}
          </p>
        </div>
        {icon ? (
          <span
            aria-hidden="true"
            className={`flex h-9 w-9 items-center justify-center rounded-md ${TONE_ACCENT[tone]}`}
          >
            {icon}
          </span>
        ) : null}
      </div>
      <div className="mt-3 flex items-center justify-between gap-2">
        {hint ? <p className="truncate text-xs text-neutral-500">{hint}</p> : <span />}
        {renderDelta()}
      </div>
    </>
  )

  const base = `relative block overflow-hidden rounded-xl border border-neutral-200 ${TONE_BG[tone]} p-4 pl-5 shadow-card transition-shadow hover:shadow-card-hover`

  if (href) {
    return (
      <Link href={href} className={`${base} focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500`}>
        {body}
      </Link>
    )
  }
  return <div className={base}>{body}</div>
}
