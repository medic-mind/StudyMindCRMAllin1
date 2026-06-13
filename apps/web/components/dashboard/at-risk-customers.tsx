// At-risk customers panel for the dashboard (CLAUDE.md §6.4 — derived hours
// risk, never stored). Surfaces customers sitting on booked tutoring hours
// they are not using, worst-first, so ops can reach out before the hours
// lapse. Replaces the deprecated at-risk *families* panel. RSC.

import Link from 'next/link'

export interface AtRiskCustomerRow {
  id: string
  name: string
  level: 'low' | 'medium' | 'high'
  hoursRemaining: number
  daysToExpiry: number | null
  reason: string | null
}

interface Props {
  rows: AtRiskCustomerRow[]
}

const LEVEL_CHIP: Record<AtRiskCustomerRow['level'], string> = {
  low: 'bg-neutral-100 text-neutral-600',
  medium: 'bg-amber-50 text-amber-800',
  high: 'bg-rose-50 text-rose-700',
}

function hoursLabel(h: number): string {
  // Hours are mirrored as whole/fractional values; keep it tidy.
  const rounded = Math.round(h * 10) / 10
  return `${rounded}h left`
}

export function AtRiskCustomersList({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500 shadow-sm">
        No customers are sitting on unused hours right now. This is derived live
        from booked vs delivered hours and how soon each balance expires.
      </div>
    )
  }
  return (
    <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
      {rows.map((row) => {
        const meta = [
          hoursLabel(row.hoursRemaining),
          row.daysToExpiry != null
            ? row.daysToExpiry <= 0
              ? 'expired'
              : `expires in ${row.daysToExpiry}d`
            : null,
          row.reason,
        ]
          .filter(Boolean)
          .join(' · ')
        return (
          <li key={row.id} className="px-4 py-3">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/contacts/${row.id}`} className="min-w-0 flex-1 text-sm">
                <span className="block truncate font-medium text-neutral-900 hover:text-primary-800 hover:underline">
                  {row.name}
                </span>
                <span className="mt-0.5 block truncate text-xs text-neutral-500">{meta}</span>
              </Link>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_CHIP[row.level]}`}
              >
                {row.level === 'high' ? 'high risk' : row.level === 'medium' ? 'at risk' : 'watch'}
              </span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
