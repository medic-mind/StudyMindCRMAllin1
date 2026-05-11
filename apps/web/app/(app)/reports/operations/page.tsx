// Operations report. RSC.

import { LineChart } from '@/components/charts/line-chart'
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

          <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
              Bookings delivered by week
            </h2>
            <LineChart
              title="Bookings delivered by week"
              description="Line chart showing weekly delivered hours and weekly delivered session counts across the selected period."
              xLabels={data.weekly.labels}
              series={series}
            />
          </section>

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
            <div className="mt-2 rounded-lg border border-neutral-200 bg-white shadow-sm">
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
            </div>
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
    <div className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-neutral-500">
        {label}
      </div>
      <div className={`mt-1 font-mono text-2xl font-semibold tabular-nums ${accent}`}>
        {value}
      </div>
    </div>
  )
}
