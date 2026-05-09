// Finance report. RSC.

import Link from 'next/link'

import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { fmtMoney, parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

export default async function FinanceReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const caller = await createServerCaller()
  const data = await caller.reports.finance.summary({
    from: period.from,
    to: period.to,
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Finance report</h1>
        <Link href="/reports" className="text-sm text-neutral-600 underline">
          Back to reports
        </Link>
      </div>
      <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Money in
        </h2>
        <p className="mt-2 text-3xl font-mono">{fmtMoney(data.moneyInMinor)}</p>
        {data.revertedMinor > 0 ? (
          <p className="mt-1 text-xs text-amber-700">
            Reverted (late failures): {fmtMoney(data.revertedMinor)}
          </p>
        ) : null}
        <ul className="mt-2 text-xs text-neutral-600">
          {Object.entries(data.byProviderMinor).map(([prov, m]) => (
            <li key={prov}>
              <span className="font-mono">{prov}</span>: {fmtMoney(m)}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Open discrepancies
        </h2>
        <div className="mt-2 rounded-md border border-neutral-200 bg-white">
          {data.openDiscrepancies.length === 0 ? (
            <p className="p-4 text-sm text-neutral-600">No open discrepancies.</p>
          ) : (
            <Table>
              <Thead>
                <Tr>
                  <Th>Category</Th>
                  <Th>Count</Th>
                </Tr>
              </Thead>
              <Tbody>
                {data.openDiscrepancies.map((d) => (
                  <Tr key={d.category}>
                    <Td className="font-mono text-xs">{d.category}</Td>
                    <Td>{d.count}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Reconciliation lag
        </h2>
        <p className="mt-2 text-sm text-neutral-700">
          Sample: {data.reconciliationLag.sampleSize} payments allocated in period.{' '}
          p50:{' '}
          {data.reconciliationLag.p50Sec === null
            ? '—'
            : `${Math.round(data.reconciliationLag.p50Sec)}s`}
          , p90:{' '}
          {data.reconciliationLag.p90Sec === null
            ? '—'
            : `${Math.round(data.reconciliationLag.p90Sec)}s`}
        </p>
      </section>
    </div>
  )
}
