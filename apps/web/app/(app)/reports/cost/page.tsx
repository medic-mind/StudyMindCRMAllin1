// Cost report. Reads from the S3 archive when configured; falls back to
// the live aggregator. CLAUDE.md §32.

import Link from 'next/link'

import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

export default async function CostReportPage() {
  const caller = await createServerCaller()
  const archive = await caller.cost.history({ limit: 12 })
  const live =
    archive.reports.length === 0
      ? await caller.cost.latest({ weeks: 12 })
      : null

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Cost</h1>
        <Link href="/reports" className="text-sm text-neutral-600 underline">
          Back to reports
        </Link>
      </div>
      <p className="text-sm text-neutral-600">
        Weekly AI + storage summary. Per CLAUDE.md §32, AI spend is estimated
        from a 1% drift sample × 100; storage uses interaction counts as a
        proxy until S3 inventory is wired.
      </p>

      {archive.reports.length > 0 ? (
        <ul className="space-y-4">
          {archive.reports.map((r) => (
            <li
              key={r.s3Key}
              className="rounded-md border border-neutral-200 bg-white p-4"
            >
              <div className="flex items-center justify-between">
                <h2 className="font-mono text-sm">{r.weekIso}</h2>
                <a
                  href={r.signedUrl}
                  className="text-sm underline"
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
                className="rounded-md border border-neutral-200 bg-white p-4"
              >
                <div className="flex items-center justify-between">
                  <h2 className="font-mono text-sm">{r.weekIso}</h2>
                  <span className="font-mono text-sm text-neutral-700">
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
            Showing live data — S3_COST_REPORTS_BUCKET not configured for this
            environment, or no archive entries yet.
          </p>
        </>
      )}
    </div>
  )
}
