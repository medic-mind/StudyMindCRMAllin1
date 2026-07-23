// Cost report. Reads from the S3 archive when configured; falls back to
// the live aggregator. CLAUDE.md §32.
//
// Resilient by design: the data sources are optional/fragile in some
// environments (S3 archive creds, drift-sample rows, finance-tier access), so
// every fetch is guarded — a failure renders a friendly inline note instead of
// crashing the whole Reports segment (the "AI cost shows an error / won't open"
// report).

import { LineChart } from '@/components/charts/line-chart'
import { CHART_PALETTE } from '@/components/charts/types'
import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Card } from '@/components/ui/card'
import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

interface ArchiveReport {
  weekIso: string
  s3Key: string
  signedUrl: string
  lastModified: string | null
  markdown: string
}
interface LiveReport {
  weekIso: string
  aiTotalUsd: number
  markdown: string
}

function errorCode(e: unknown): string | null {
  if (e && typeof e === 'object' && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code
  }
  return null
}

export default async function CostReportPage() {
  const caller = await createServerCaller()

  // Archive (S3) — optional. Any failure (bucket unset, creds, access) falls
  // back to the live aggregator rather than erroring the page.
  let archive: ArchiveReport[] = []
  try {
    archive = (await caller.cost.history({ limit: 12 })).reports
  } catch (e) {
    // FORBIDDEN is surfaced below via the live fetch; other errors just mean
    // "no archive" and we show live data.
    if (errorCode(e) === 'FORBIDDEN') {
      return <Forbidden />
    }
  }

  // Live aggregator — only needed when the archive is empty.
  let live: LiveReport[] = []
  let liveError: string | null = null
  if (archive.length === 0) {
    try {
      live = (await caller.cost.latest({ weeks: 8 })).reports
    } catch (e) {
      if (errorCode(e) === 'FORBIDDEN') return <Forbidden />
      liveError = 'Cost data could not be computed right now — try again shortly.'
    }
  }

  // Line series: archive markdown doesn't expose totals, so plot the live
  // weekly totals when available. Guard every y-value to a finite number.
  const series =
    archive.length === 0
      ? live
          .slice()
          .reverse()
          .map((r) => ({
            x: r.weekIso.slice(5),
            y: Number.isFinite(r.aiTotalUsd) ? Math.round(r.aiTotalUsd * 100) / 100 : 0,
          }))
      : []

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

          {liveError ? (
            <Card className="border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              {liveError}
            </Card>
          ) : null}

          {series.length > 0 ? (
            <Card className="p-4">
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
            </Card>
          ) : null}

          {archive.length > 0 ? (
            <ul className="space-y-4">
              {archive.map((r) => (
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
          ) : live.length > 0 ? (
            <>
              <ul className="space-y-4">
                {live.map((r) => (
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
          ) : liveError ? null : (
            <Card className="p-6 text-center text-sm text-neutral-500">
              No cost data yet — the weekly summary populates as AI usage is
              sampled (CLAUDE.md §32).
            </Card>
          )}
        </div>
      </PageBody>
    </>
  )
}

function Forbidden() {
  return (
    <>
      <PageHeader
        title="Cost reports"
        breadcrumbs={[
          { label: 'Reports', href: '/reports' },
          { label: 'Cost', href: '/reports/cost' },
        ]}
      />
      <PageBody>
        <Card className="p-6 text-sm text-neutral-600">
          You need the Manager, Senior Manager, or CEO role to view cost
          reports.
        </Card>
      </PageBody>
    </>
  )
}
