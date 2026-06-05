// Recurring Aircall calls sync (CLAUDE.md §10). Keeps the call mirror COMPLETE
// even when a webhook is missed, disabled, or was connected late: every 10 min
// it pulls recent calls from the Aircall REST API (matched AND unmatched) and
// upserts them idempotently on the Aircall call id. So everything that happens
// on Aircall is reflected in the CRM — not just what arrived live over the
// webhook.
//
// No-ops when AIRCALL_API_ID / AIRCALL_API_TOKEN are unset, so the CRM runs
// fine before Aircall is wired up. Deep history is handled by the on-demand
// admin backfill; this job covers the live/recent window going forward.

import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { processBackfillCall } from './backfill'
import { createClient, type AircallCallResource } from './client'

const OVERLAP_MS = 60 * 60 * 1000 // re-pull the last hour each run (idempotent)
const DEFAULT_LOOKBACK_DAYS = 90
const MAX_PAGES = 40 // bound per run: 40 × 50 = 2000 calls

export const aircallSyncCalls = inngest.createFunction(
  {
    id: 'aircall/sync-calls',
    name: 'Sync recent Aircall calls',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '*/10 * * * *' },
  async ({ step, logger }) => {
    if (!process.env['AIRCALL_API_ID'] || !process.env['AIRCALL_API_TOKEN']) {
      return { skipped: 'no-credentials' }
    }

    // Cursor without a dedicated table: resume from just before our newest
    // stored call (minus an overlap so nothing slips between runs); if we have
    // no calls yet, look back a bounded window.
    const since = await step.run('compute-since', async () => {
      const latest = await db.interaction.findFirst({
        where: { type: 'call' },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      })
      const lookbackDays = Number(
        process.env['AIRCALL_SYNC_LOOKBACK_DAYS'] ?? DEFAULT_LOOKBACK_DAYS,
      )
      const fallback = Date.now() - lookbackDays * 24 * 60 * 60 * 1000
      const base = latest?.occurredAt ? latest.occurredAt.getTime() - OVERLAP_MS : fallback
      return Math.floor(base / 1000)
    })
    const toUnix = Math.floor(Date.now() / 1000)

    let processed = 0
    let stored = 0
    let page = 1
    let keepPaging = true
    const client = createClient()

    while (keepPaging && page <= MAX_PAGES) {
      const res = await step.run(`list-page-${page}`, async () => {
        const r = await client.request<{
          calls: AircallCallResource[]
          meta?: { next_page_link?: string | null }
        }>('GET', `/calls?from=${since}&to=${toUnix}&order=asc&per_page=50&page=${page}`)
        return { rows: r.calls ?? [], hasNext: !!r.meta?.next_page_link }
      })

      for (const call of res.rows) {
        const result = await step.run(`call-${call.id}`, async () => processBackfillCall(call))
        processed += 1
        if (result.created) stored += 1
      }
      keepPaging = res.hasNext
      page += 1
    }

    logger.info({ processed, stored, since }, 'aircall.sync_calls.completed')
    return { processed, stored, pages: page - 1, cappedAtMaxPages: keepPaging }
  },
)
