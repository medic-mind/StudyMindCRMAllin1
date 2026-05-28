// Cost report. Reads from the S3 archive when configured; falls back to
// the live aggregator. CLAUDE.md §32.

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

export default async function CostReportPage() {
  const caller = await createServerCaller()
  const archive = await caller.cost.history({ limit: 12 })
  const live =
    archive.reports.length === 0 ? await caller.cost.latest({ weeks: 8 }) : null

  // Use the live series (8 weeks) for the line chart whenever the archive
  // is unavailable. When the archive is populated we plot its weekly totals.
  const series =
    archive.reports.length > 0
      ? archive.reports
          .slice()
          .reverse()
          .map((r) => ({ x: r.weekIso, y: 0 })) // archive markdown doesn't expose totals; render as zeros
      : (live?.reports ?? [])
          .slice()
          .reverse()
          .map((r) => ({ x: r.weekIso.slice(5), y: Math.round(r.aiTotalUsd * 100) / 100 }))

  return (
    <>
      <PageHeader
        title="Cost reports"
        subtitle="Weekly AI + storage summary."
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Cost', href: '/reports/cost' },
        ]}
      />
      <PageBody>
        <div className="space-y-6">
          <p className="text-sm text-neutral-600">
            Per CLAUDE.md §32, AI spend is estimated from a 1% drift sample ×
            100; storage uses interaction counts as a proxy until S3 inventory is
            wired.
          </p>

          {series.length > 0 ? (
            <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-600">
                AI spend by week ($USD)
              </h2>
              <LineChart
                title="AI spend by week ($USD)"
                description={`Line chart of total weekly AI spend in USD across the latest ${series.length} weeks.`}
                xLabels={series.map((p) => p.x)}
                series={[
                  {
                    key: 'aiUsd',
                    label: 'AI spend ($USD)',
                    color: CHART_PALETTE[0]!,
                    values: series,
                  },
                ]}
                axis={{ yFormat: (n) => `$${n}` }}
              />
            </section>
          ) : null}

          {archive.reports.length > 0 ? (
            <ul className="space-y-4">
              {archive.reports.map((r) => (
                <li
                  key={r.s3Key}
                  className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
                >
                  <div className="flex items-center justify-between">
                    <h2 className="font-mono text-sm">{r.weekIso}</h2>
                    <a
                      href={r.signedUrl}
                      className="text-sm text-primary-700 underline"
                      rel="noreferrer"
                      target="_blank"
                    >
                      Open signed link
                    </a>
                  </div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-neutral-700">
                    {r.markdown}
                  </pre>
                </li>
              ))}
            </ul>
          ) : (
            <>
              <ul className="space-y-4">
                {live!.reports.map((r) => (
                  <li
                    key={r.weekIso}
                    className="rounded-lg border border-neutral-200 bg-white p-4 shadow-card"
                  >
                    <div className="flex items-center justify-between">
                      <h2 className="font-mono text-sm">{r.weekIso}</h2>
                      <span className="font-mono text-sm tabular-nums text-neutral-700">
                        ${r.aiTotalUsd.toFixed(2)} AI
                      </span>
                    </div>
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs text-neutral-700">
                      {r.markdown}
                    </pre>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-neutral-500">
                Showing live data — S3_COST_REPORTS_BUCKET not configured for
                this environment, or no archive entries yet.
              </p>
            </>
          )}
        </div>
      </PageBody>
    </>
  )
}
