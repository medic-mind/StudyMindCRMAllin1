// LA contracts dashboard. CLAUDE.md §43.2-§43.3, §26 (RSC by default,
// dense lists, plain English empty states).

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { createServerCaller } from '@/lib/trpc/server'

const REPORT_DEADLINE_WARN_DAYS = 5

function formatGbp(minor: number): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(minor / 100)
}

function workingDaysUntil(date: Date): number {
  const now = new Date()
  const diff = Math.ceil((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000))
  return diff
}

export default async function LAContractsPage() {
  const caller = await createServerCaller()
  let contracts: Awaited<ReturnType<typeof caller.lacontract.list>> = []
  let forbidden = false
  try {
    contracts = await caller.lacontract.list()
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">LA contracts</h1>
        <p className="mt-2 text-sm text-neutral-600">
          You need an account-lead, finance, or admin role to view LA contracts.
        </p>
      </div>
    )
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">LA contracts</h1>
      <p className="mt-2 text-sm text-neutral-600">
        Active Local Authority contracts with their report cadence and
        invoicing status. LA-billed families do not use Stripe or
        GoCardless — invoicing is manual and reconciled against the LA
        purchase order.
      </p>

      {contracts.length === 0 ? (
        <div className="mt-8 rounded-lg border border-neutral-200 bg-neutral-50 p-6 text-sm text-neutral-700">
          No LA contracts yet. Award a tender on the Tenders board to create
          the contract and learner placements.
        </div>
      ) : (
        <ul className="mt-8 divide-y divide-neutral-200 rounded-lg border border-neutral-200">
          {contracts.map((c) => {
            const deadlineSoon =
              c.endDate && workingDaysUntil(c.endDate) <= REPORT_DEADLINE_WARN_DAYS
            return (
              <li key={c.id} className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="text-sm font-medium text-neutral-900">
                    <Link
                      className="hover:underline"
                      href={`/finance/la-contracts/${c.id}/reports`}
                    >
                      {c.laName}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-neutral-500">{c.reference}</span>
                    {deadlineSoon ? (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-800">
                        Report deadline soon
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-1 text-xs text-neutral-600">
                    {c._count.families} learners · {c._count.invoices} invoices ·{' '}
                    {c._count.reports} reports · {c.reportingCadence}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm tabular-nums text-neutral-900">
                    {formatGbp(c.contractValueMinor)}
                  </div>
                  <div className="font-mono text-xs text-neutral-500">
                    {c.startDate.toISOString().slice(0, 10)}
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
