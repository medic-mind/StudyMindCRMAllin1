// Reaper for abandoned backfill jobs (ADR 0017, CLAUDE.md §17).
//
// A web service redeployed mid-import — or an Inngest run that is never picked
// up — leaves a BackfillJob stuck `pending`/`running` forever. That showed a
// permanent "Importing 0 items…" banner and a perpetual "stuck backfills"
// count in the integrations diagnostics. `startBackfill` already supersedes one
// such row when an operator re-triggers the same provider; this cron closes the
// gap by self-healing them on a schedule, with no operator action.

import { reapStaleBackfills } from '@studymind/core/backfill'
import { recordCronRun } from '@studymind/core/observability/cron-heartbeat'
import { db } from '@studymind/db'

import { inngest } from '../client'

export const backfillReapStale = inngest.createFunction(
  {
    id: 'backfill/reap-stale',
    name: 'Reap abandoned backfill jobs',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/10 * * * *' },
  async ({ step, logger }) => {
    const startedAt = Date.now()
    const reaped = await step.run('reap', async () => reapStaleBackfills(db))
    await step.run('heartbeat', () =>
      recordCronRun(db, {
        functionId: 'backfill/reap-stale',
        success: true,
        durationMs: Date.now() - startedAt,
      }),
    )
    if (reaped.length > 0) {
      logger.warn({ reaped }, 'backfill.reap_stale.completed')
    }
    return { reaped: reaped.length }
  },
)

export const BACKFILL_REAPER_FUNCTIONS = [backfillReapStale] as const
