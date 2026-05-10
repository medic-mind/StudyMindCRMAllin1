// Cron heartbeat. CLAUDE.md §17, §25, Slice 14.
//
// Recurring Inngest functions call recordCronRun() at the end of every run.
// The cron watchdog (packages/jobs/src/observability/cron-watchdog.ts) walks
// the table and pages on missed cycles.

import { createId } from '@paralleldrive/cuid2'

export interface CronRunDb {
  cronRun: {
    create: (args: {
      data: {
        id: string
        functionId: string
        success: boolean
        durationMs: number
        startedAt: Date
        finishedAt: Date
        errorCode: string | null
      }
    }) => Promise<unknown>
  }
}

export interface RecordCronRunInput {
  functionId: string
  success: boolean
  durationMs: number
  startedAt?: Date
  finishedAt?: Date
  errorCode?: string | null
}

export async function recordCronRun(
  db: CronRunDb,
  input: RecordCronRunInput,
): Promise<string> {
  const id = createId()
  const finishedAt = input.finishedAt ?? new Date()
  const startedAt =
    input.startedAt ?? new Date(finishedAt.getTime() - input.durationMs)
  await db.cronRun.create({
    data: {
      id,
      functionId: input.functionId,
      success: input.success,
      durationMs: input.durationMs,
      startedAt,
      finishedAt,
      errorCode: input.errorCode ?? null,
    },
  })
  return id
}

/**
 * Wrap an async unit of work so a `CronRun` row is written whether it
 * succeeds or throws. Re-raises the original error so Inngest still retries.
 */
export async function withCronHeartbeat<T>(
  db: CronRunDb,
  functionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date()
  try {
    const result = await fn()
    await recordCronRun(db, {
      functionId,
      success: true,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
      finishedAt: new Date(),
    })
    return result
  } catch (e) {
    await recordCronRun(db, {
      functionId,
      success: false,
      durationMs: Date.now() - startedAt.getTime(),
      startedAt,
      finishedAt: new Date(),
      errorCode: (e as Error).name,
    }).catch(() => {
      // Swallow: heartbeat failure must not mask the real error.
    })
    throw e
  }
}
