// Finance report. RSC.

import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
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
  const [data, complaints] = await Promise.all([
    caller.reports.finance.summary({
      from: period.from,
      to: period.to,
    }),
    caller.complaint.periodCounts({ from: period.from, to: period.to }),
  ])

  const fmtPence = (m: number) => fmtMoney(m)
  const series = [
    {
      key: 'moneyIn',
      label: 'Money in',
      color: CHART_PALETTE[0]!,
      values: data.weekly.labels.map((x, i) => ({
        x,
        y: data.weekly.moneyInMinor[i] ?? 0,
      })),
    },
    {
      key: 'unallocated',
      label: 'Unallocated',
      color: CHART_PALETTE[2]!,
      values: data.weekly.labels.map((x, i) => ({
        x,
        y: data.weekly.unallocatedMinor[i] ?? 0,
      })),
    },
    {
      key: 'reverted',
      label: 'Reverted',
      color: CHART_PALETTE[3]!,
      values: data.weekly.labels.map((x, i) => ({
        x,
        y: data.weekly.revertedMinor[i] ?? 0,
      })),
    },
  ]

  return (
    <>
      <PageHeader
        title="Finance reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Finance', href: '/reports/finance' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

          <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Money in by week
            </h2>
            <StackedBarChart
              title="Money in vs reverted vs unallocated, by week"
              description="Stacked bar chart showing weekly money in, reverted (late failures), and unallocated payments across the selected period."
              xLabels={data.weekly.labels}
              series={series}
              axis={{ yFormat: fmtPence }}
            />
          </section>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Money in" value={fmtMoney(data.moneyInMinor)} tone="info" />
            <Kpi
              label="Reverted (late failures)"
              value={fmtMoney(data.revertedMinor)}
              tone={data.revertedMinor > 0 ? 'warn' : 'neutral'}
            />
            <Kpi
              label="Reconciliation lag p90"
              value={
                data.reconciliationLag.p90Sec === null
                  ? '—'
                  : `${Math.round(data.reconciliationLag.p90Sec)}s`
              }
              tone="neutral"
              hint={`p50 ${
                data.reconciliationLag.p50Sec === null
                  ? '—'
                  : `${Math.round(data.reconciliationLag.p50Sec)}s`
              } · n=${data.reconciliationLag.sampleSize}`}
            />
            <Kpi
              label="Active complaints"
              value={String(complaints.activeBacklog)}
              tone={complaints.activeBacklog > 0 ? 'danger' : 'neutral'}
              hint={`${complaints.openedInPeriod} opened this period`}
            />
          </div>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              By provider
            </h2>
            <div className="mt-2 rounded-lg border border-neutral-200 bg-white shadow-card">
              {Object.keys(data.byProviderMinor).length === 0 ? (
                <p className="p-4 text-sm text-neutral-500">
                  No payments received in this period.
                </p>
              ) : (
                <Table>
                  <Thead>
                    <Tr>
                      <Th>Provider</Th>
                      <Th>Money in</Th>
                    </Tr>
                  </Thead>
                  <Tbody>
                    {Object.entries(data.byProviderMinor).map(([prov, m]) => (
                      <Tr key={prov}>
                        <Td className="font-mono text-xs">{prov}</Td>
                        <Td className="font-mono tabular-nums">{fmtMoney(m)}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </div>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Open discrepancies
            </h2>
            <div className="mt-2 rounded-lg border border-neutral-200 bg-white shadow-card">
              {data.openDiscrepancies.length === 0 ? (
                <p className="p-4 text-sm text-neutral-500">
                  No open discrepancies — reconciliation is clean.
                </p>
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
                        <Td className="tabular-nums">{d.count}</Td>
                      </Tr>
                    ))}
                  </Tbody>
                </Table>
              )}
            </div>
          </section>
        </div>
      </PageBody>
    </>
  )
}

function Kpi({
  label,
  value,
  tone,
  hint,
}: {
  label: string
  value: string
  tone: 'info' | 'warn' | 'danger' | 'neutral'
  hint?: string
}) {
  const accent =
    tone === 'info'
      ? 'text-primary-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : tone === 'danger'
          ? 'text-rose-700'
          : 'text-neutral-900'
  return (
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
      <p className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </p>
      <p className={`mt-2 font-mono text-2xl font-semibold tabular-nums ${accent}`}>
        {value}
      </p>
      {hint ? <p className="mt-1 text-xs text-neutral-500">{hint}</p> : null}
    </div>
  )
}
