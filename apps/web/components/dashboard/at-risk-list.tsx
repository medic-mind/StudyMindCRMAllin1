// At-risk families panel for the dashboard. RSC.

import Link from 'next/link'

export interface AtRiskRow {
  id: string
  name: string | null
  reasons: string[]
}

interface Props {
  rows: AtRiskRow[]
}

export function AtRiskList({ rows }: Props) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-neutral-200 bg-white p-6 text-sm text-neutral-500 shadow-sm">
        No families are currently at risk. Reconciliation derives this nightly
        from Stripe past-due, failed Direct Debits, and churn score.
      </div>
    )
  }
  return (
    <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
      {rows.map((row) => (
        <li key={row.id} className="px-4 py-3">
          <div className="flex items-start justify-between gap-3">
            <Link
              href={`/contacts/families/${row.id}`}
              className="min-w-0 flex-1 text-sm"
            >
              <span className="block truncate font-medium text-neutral-900 hover:text-primary-800 hover:underline">
                {row.name ?? 'Unnamed family'}
              </span>
              <span className="mt-0.5 block truncate text-xs text-neutral-500">
                {row.reasons.join(' · ')}
              </span>
            </Link>
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800">
              at risk
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}
