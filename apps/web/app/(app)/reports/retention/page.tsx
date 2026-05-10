// Retention report. RSC.

import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

import { PeriodForm } from '../_components/period-form'
import { parsePeriod } from '../period'

export const dynamic = 'force-dynamic'

interface SP {
  from?: string
  to?: string
}

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

  const histMax = Math.max(1, ...data.churnScoreHistogram)

  return (
    <>
      <PageHeader
        title="Retention reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Retention', href: '/reports/retention' },
        ]}
      />
      <div className="space-y-6">
      <PeriodForm fromIso={period.fromIso} toIso={period.toIso} />

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Families by lifecycle state
        </h2>
        <ul className="mt-2 grid grid-cols-2 gap-1 text-xs text-neutral-700 sm:grid-cols-5">
          {data.familiesByState.map((f) => (
            <li key={f.state} className="rounded border border-neutral-200 bg-white p-2">
              <div className="font-mono text-xs">{f.state}</div>
              <div className="font-mono text-lg">{f.count}</div>
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Churn score histogram (deciles)
        </h2>
        <p className="mt-1 text-xs text-neutral-500">
          {data.churnScoreSamples} score(s) in selected period.
        </p>
        <div className="mt-2 grid grid-cols-10 gap-1">
          {data.churnScoreHistogram.map((count, idx) => (
            <div key={idx} className="text-center">
              <div
                className="mx-auto bg-blue-500"
                style={{
                  height: `${(count / histMax) * 80}px`,
                  width: '12px',
                }}
                aria-label={`Decile ${idx}: ${count} families`}
              />
              <div className="mt-1 font-mono text-[10px] text-neutral-500">
                {(idx / 10).toFixed(1)}
              </div>
              <div className="font-mono text-[10px]">{count}</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-neutral-600 uppercase tracking-wide">
          Lifecycle state changes in period
        </h2>
        <p className="mt-1 font-mono text-2xl">{data.churnEventsInPeriod}</p>
      </section>
      </div>
    </>
  )
}
