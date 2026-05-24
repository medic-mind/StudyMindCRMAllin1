// Backfill progress banner (ADR 0017). When the current user has a running
// BackfillJob (their own per-agent job, or a shared-token job), this shows
// an importing pill with a progress bar. Polls every 5s while running.
//
// Client island: the (app) shell mounts it; it renders nothing when there is
// no running job.

'use client'

import { trpc } from '@/lib/trpc/client'

const PROVIDER_LABEL: Record<string, string> = {
  gmail: 'Gmail',
  aircall: 'Aircall',
  trengo: 'Trengo',
  slack: 'Slack',
}

export function BackfillProgressBanner(): JSX.Element | null {
  const { data } = trpc.admin.backfill.mine.useQuery(undefined, {
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  })

  if (!data || data.length === 0) return null

  return (
    <div className="border-b border-blue-200 bg-blue-50 px-6 py-2 text-sm text-blue-900">
      {data.map((job) => {
        const pct =
          job.totalCount && job.totalCount > 0
            ? Math.min(100, Math.round((job.processedCount / job.totalCount) * 100))
            : null
        return (
          <div key={job.id} className="flex items-center gap-3">
            <span>
              Importing {job.processedCount.toLocaleString('en-GB')}
              {job.totalCount ? ` of ${job.totalCount.toLocaleString('en-GB')}` : ''}{' '}
              {PROVIDER_LABEL[job.provider] ?? job.provider} item
              {job.processedCount === 1 ? '' : 's'}
              {pct !== null ? ` — ${pct}% done` : '…'}
            </span>
            <div className="h-1.5 w-40 overflow-hidden rounded bg-blue-200">
              <div
                className="h-full bg-blue-600 transition-all"
                style={{ width: pct !== null ? `${pct}%` : '40%' }}
                role="progressbar"
                aria-valuenow={pct ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
