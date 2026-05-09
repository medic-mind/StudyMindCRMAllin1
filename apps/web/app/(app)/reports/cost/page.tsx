// Cost report. Shows the latest 12 weekly summaries inline.
// CLAUDE.md §32. Today the data is computed live from DriftSample +
// proxy interaction counts; production will read from S3 archives.

import Link from 'next/link'

import { createServerCaller } from '@/lib/trpc/server'

export const dynamic = 'force-dynamic'

export default async function CostReportPage() {
  const caller = await createServerCaller()
  const data = await caller.cost.latest({ weeks: 12 })

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

      <ul className="space-y-4">
        {data.reports.map((r) => (
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
            <pre className="mt-2 overflow-x-auto text-xs text-neutral-700 whitespace-pre-wrap">
              {r.markdown}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  )
}
