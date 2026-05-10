// Retention report. RSC.

import { Histogram } from '@/components/charts/histogram'
import { StackedBarChart } from '@/components/charts/stacked-bar-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

const FAMILY_STATES = ['lead', 'trial', 'active', 'at_risk', 'churned'] as const

export default async function RetentionReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const caller = await createServerCaller()
  const data = await caller.reports.retention.summary({
    from: period.from,
    to: period.to,
  })

  // The retention summary returns current totals by state — render as a
  // single-stack bar so the visual matches the other reports without
  // claiming weekly history we don't compute yet.
  const stateCounts = new Map<string, number>()
  for (const r of data.familiesByState) stateCounts.set(r.state, r.count)
  const stackedSeries = FAMILY_STATES.map((state, i) => ({
    key: state,
    label: state.replace('_', ' '),
    color: CHART_PALETTE[i] ?? CHART_PALETTE[0]!,
    values: [{ x: 'Now', y: stateCounts.get(state) ?? 0 }],
  }))

  const histLabels = data.churnScoreHistogram.map(
    (_, i) => `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)}`,
  )

  return (
    <>
      <PageHeader
        title="Retention reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Retention', href: '/reports/retention' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                Families by lifecycle state
              </h2>
              <StackedBarChart
                title="Families by lifecycle state"
                description="Stacked bar chart showing the current distribution of families across lifecycle states: lead, trial, active, at risk, churned."
                xLabels={['Now']}
                series={stackedSeries}
                height={200}
                width={360}
              />
            </section>

            <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                Churn score distribution (deciles)
              </h2>
              <p className="mb-3 text-xs text-neutral-500">
                {data.churnScoreSamples} score(s) recorded in the selected period.
                Scores ≥ 0.7 are flagged for retention follow-up.
              </p>
              <Histogram
                title="Churn score distribution by decile"
                description={`Distribution of churn scores by decile across ${data.churnScoreSamples} samples in the selected period.`}
                buckets={data.churnScoreHistogram}
                labels={histLabels}
                warnThresholdIndex={7}
              />
            </section>
          </div>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Lifecycle state changes in period
            </h2>
            <p className="mt-2 font-mono text-3xl tabular-nums text-neutral-900">
              {data.churnEventsInPeriod}
            </p>
            <p className="text-xs text-neutral-500">
              State transitions logged via family_state_changed Interactions.
            </p>
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Per-state breakdown
            </h2>
            <div className="mt-2 rounded-lg border border-neutral-200 bg-white shadow-sm">
              <Table>
                <Thead>
                  <Tr>
                    <Th>State</Th>
                    <Th>Count</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {data.familiesByState.map((row) => (
                    <Tr key={row.state}>
                      <Td className="font-mono text-xs">{row.state}</Td>
                      <Td className="tabular-nums">{row.count}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            </div>
          </section>
        </div>
      </PageBody>
    </>
  )
}
