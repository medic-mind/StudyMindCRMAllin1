// Operations report. RSC.

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { Table, Tbody, Td, Th, Thead, Tr } from '@/components/ui/table'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

export default async function OperationsReportPage({
  searchParams,
}: {
  searchParams: Promise<SP>
}) {
  const sp = await searchParams
  const period = parsePeriod(sp)
  const caller = await createServerCaller()
  const data = await caller.reports.operations.summary({
    from: period.from,
    to: period.to,
  })

  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

  const series = [
    {
      key: 'hours',
      label: 'Hours delivered',
      color: CHART_PALETTE[0]!,
      values: data.weekly.labels.map((x, i) => ({
        x,
        y: data.weekly.deliveredHours[i] ?? 0,
      })),
    },
    {
      key: 'sessions',
      label: 'Sessions delivered',
      color: CHART_PALETTE[2]!,
      values: data.weekly.labels.map((x, i) => ({
        x,
        y: data.weekly.deliveredSessions[i] ?? 0,
      })),
    },
  ]

  return (
    <>
      <PageHeader
        title="Operations reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Operations', href: '/reports/operations' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Delivery by week
            </h2>
            <LineChart
              title="Hours and sessions delivered, by week"
              description="Line chart showing weekly delivered hours and weekly delivered session counts across the selected period."
              xLabels={data.weekly.labels}
              series={series}
            />
          </Card>

          <section className="grid gap-4 sm:grid-cols-3">
            <Stat label="Sessions scheduled" value={data.sessionsByState.scheduled} />
            <Stat label="Delivered" value={data.sessionsByState.delivered} tone="info" />
            <Stat
              label="Missed-session rate"
              value={pct(data.missedSessionRate)}
              tone={data.missedSessionRate > 0.1 ? 'warn' : 'neutral'}
            />
            <Stat label="Hours scheduled" value={data.scheduledHours} />
            <Stat label="Hours delivered" value={data.deliveredHours} tone="info" />
            <Stat
              label="Cancelled / no-show"
              value={data.sessionsByState.cancelled + data.sessionsByState.noShow}
              tone="warn"
            />
          </section>

          <section>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-600">
              By session state
            </h2>
            <Card className="mt-2 overflow-hidden">
              <Table>
                <Thead>
                  <Tr>
                    <Th>State</Th>
                    <Th>Count</Th>
                  </Tr>
                </Thead>
                <Tbody>
                  <Tr>
                    <Td>tentative</Td>
                    <Td className="tabular-nums">{data.sessionsByState.tentative}</Td>
                  </Tr>
                  <Tr>
                    <Td>confirmed</Td>
                    <Td className="tabular-nums">{data.sessionsByState.confirmed}</Td>
                  </Tr>
                  <Tr>
                    <Td>delivered</Td>
                    <Td className="tabular-nums">{data.sessionsByState.delivered}</Td>
                  </Tr>
                  <Tr>
                    <Td>no_show</Td>
                    <Td className="tabular-nums">{data.sessionsByState.noShow}</Td>
                  </Tr>
                  <Tr>
                    <Td>cancelled</Td>
                    <Td className="tabular-nums">{data.sessionsByState.cancelled}</Td>
                  </Tr>
                </Tbody>
              </Table>
            </Card>
          </section>
        </div>
      </PageBody>
    </>
  )
}

function Stat({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: number | string
  tone?: 'info' | 'warn' | 'neutral'
}) {
  const accent =
    tone === 'info'
      ? 'text-primary-700'
      : tone === 'warn'
        ? 'text-amber-700'
        : 'text-neutral-900'
  return (
    <Card className="p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent}`}>
        {value}
      </div>
    </Card>
  )
}
