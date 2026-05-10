// Operations report. RSC.

import { PageHeader } from '@/components/shell/page-header'
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

  return (
    <>
      <PageHeader
        title="Operations reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Operations', href: '/reports/operations' },
        ]}
      />
      <div className="space-y-6">
      <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

      <section className="grid gap-4 sm:grid-cols-3">
        <Stat label="Sessions scheduled" value={data.sessionsByState.scheduled} />
        <Stat label="Delivered" value={data.sessionsByState.delivered} />
        <Stat label="Missed-session rate" value={pct(data.missedSessionRate)} />
        <Stat label="Hours scheduled" value={data.scheduledHours} />
        <Stat label="Hours delivered" value={data.deliveredHours} />
        <Stat
          label="Cancelled / no-show"
          value={data.sessionsByState.cancelled + data.sessionsByState.noShow}
        />
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          By session state
        </h2>
        <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-neutral-700 sm:grid-cols-5">
          <li>tentative: {data.sessionsByState.tentative}</li>
          <li>confirmed: {data.sessionsByState.confirmed}</li>
          <li>delivered: {data.sessionsByState.delivered}</li>
          <li>no_show: {data.sessionsByState.noShow}</li>
          <li>cancelled: {data.sessionsByState.cancelled}</li>
        </ul>
      </section>
      </div>
    </>
  )
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-md border border-neutral-200 bg-white p-4">
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 font-mono text-2xl">{value}</div>
    </div>
  )
}
