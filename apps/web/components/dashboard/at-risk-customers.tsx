// At-risk customers panel for the dashboard (CLAUDE.md §6.4 — derived hours
// risk, never stored). Surfaces customers sitting on booked tutoring hours
// they are not using, worst-first, so ops can reach out before the hours
// lapse. Replaces the deprecated at-risk *families* panel. RSC.

import Link from 'next/link'

import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { ChevronRightIcon } from '@/components/ui/icon'

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
  total: number
}

const LEVEL_CHIP: Record<AtRiskCustomerRow['level'], string> = {
  low: 'bg-neutral-100 text-neutral-600',
  medium: 'bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-100',
  high: 'bg-rose-50 text-rose-700 ring-1 ring-inset ring-rose-100',
}

const LEVEL_LABEL: Record<AtRiskCustomerRow['level'], string> = {
  low: 'watch',
  medium: 'at risk',
  high: 'high risk',
}

function hoursLabel(h: number): string {
  const rounded = Math.round(h * 10) / 10
  return `${rounded}h left`
}

export function AtRiskCustomersList({ rows, total }: Props) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle>At-risk customers</CardTitle>
        <Link
          href="/contacts/at-risk"
          className="inline-flex items-center gap-0.5 text-xs font-medium text-primary-700 hover:text-primary-800"
        >
          View all{total > rows.length ? ` (${total})` : ''}
          <ChevronRightIcon size={13} />
        </Link>
      </CardHeader>
      {rows.length === 0 ? (
        <div className="p-6 text-sm text-neutral-500">
          No customers are sitting on unused hours right now. This is derived
          live from booked vs delivered hours and how soon each balance expires.
        </div>
      ) : (
        <ul className="divide-y divide-neutral-100">
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
              <li key={row.id}>
                <Link
                  href={`/contacts/${row.id}`}
                  className="flex items-start justify-between gap-3 px-5 py-3 transition-colors hover:bg-neutral-50"
                >
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="block truncate font-medium text-neutral-900">{row.name}</span>
                    <span className="mt-0.5 block truncate text-xs text-neutral-500">{meta}</span>
                  </span>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${LEVEL_CHIP[row.level]}`}
                  >
                    {LEVEL_LABEL[row.level]}
                  </span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}
