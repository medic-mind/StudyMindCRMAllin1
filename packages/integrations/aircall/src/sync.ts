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

import { recordCronRun } from '@studymind/core/observability/cron-heartbeat'
import { db, Prisma } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { processBackfillCall } from './backfill'
import { createClient, type AircallCallResource } from './client'

const OVERLAP_MS = 24 * 60 * 60 * 1000 // re-pull the last 24h each run (idempotent)
// Cold-start reach-back when we hold no calls yet: a clean 1-month import,
// matching the admin backfill window (CLAUDE.md §10). Override via
// AIRCALL_SYNC_LOOKBACK_DAYS. After the first run the cursor moves forward.
const DEFAULT_LOOKBACK_DAYS = 30
const MAX_PAGES = 60 // bound per run: 60 × 50 = 3000 calls

export const aircallSyncCalls = inngest.createFunction(
  {
    id: 'aircall/sync-calls',
    name: 'Sync recent Aircall calls',
    concurrency: { limit: 1 },
    retries: 3,
  },
  // Cron every 10 min, PLUS an on-demand trigger so staff can force an
  // immediate pull from the /calls page when a specific missed call hasn't
  // come through (e.g. a dropped webhook). Same body either way.
  [{ cron: '*/10 * * * *' }, { event: 'aircall/sync-now.requested' }],
  async ({ step, logger }) => {
    if (!process.env['AIRCALL_API_ID'] || !process.env['AIRCALL_API_TOKEN']) {
      return { skipped: 'no-credentials' }
    }
    const startedAt = Date.now()

    // Cursor without a dedicated table: resume from just before our newest
    // stored call (minus an overlap so nothing slips between runs); if we have
    // no calls yet, look back a bounded window.
    const since = await step.run('compute-since', async () => {
      const latest = await db.interaction.findFirst({
        // Aircall calls ONLY — Google Voice (source:'google_voice') and manual
        // click-to-call logs are also type:'call', and a recent non-Aircall
        // call would otherwise drag this cursor past unsynced Aircall history,
        // defeating the "missed webhook self-heals" guarantee.
        where: { type: 'call', payload: { path: ['aircallCallId'], not: Prisma.DbNull } },
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
        try {
          const result = await step.run(`call-${call.id}`, async () => processBackfillCall(call))
          processed += 1
          if (result.created) stored += 1
        } catch (err) {
          // Critical: one poison call must not fail the whole sync. Before this
          // guard, a single call that threw (e.g. a contact unique-constraint
          // clash) failed the run, and because `since` resumes from the newest
          // STORED call, every subsequent 10-min tick re-hit the same call and
          // re-failed — permanently stranding the mirror at the last good call.
          // Skip it and keep paging.
          processed += 1
          logger.warn({ callId: call.id, err }, 'aircall sync: skipped a call that failed to import')
        }
      }
      keepPaging = res.hasNext
      page += 1
    }

    // Heartbeat so "Background jobs" diagnostics + the cron watchdog can see
    // this cron is actually being invoked (proves Inngest is connected).
    await step.run('heartbeat', () =>
      recordCronRun(db, {
        functionId: 'aircall/sync-calls',
        success: true,
        durationMs: Date.now() - startedAt,
      }),
    )

    logger.info({ processed, stored, since }, 'aircall.sync_calls.completed')
    return { processed, stored, pages: page - 1, cappedAtMaxPages: keepPaging }
  },
)
