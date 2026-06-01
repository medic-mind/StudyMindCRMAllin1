// Recurring Inngest jobs that pull booking data from booking.studymind.co.uk.
//
// Student-centric incremental pull (ADR 0029). Each resource has its own
// global keyset cursor (BookingSyncCursor) so a poll makes a handful of requests
// and asks only "what changed since X?" (docs/api/booking-pull-api.md). The
// jobs no-op when the integration is unconfigured (no BOOKING_API_TOKEN) so the
// CRM is safe to ship before the booking team exposes the API.
//
// CLAUDE.md §15 (booking site is the source of truth), §17 (idempotency,
// concurrency, one summary audit per sync run — never per imported row).

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient, isConfigured } from './client'
import {
  drainIncremental,
  upsertCreditTransaction,
  upsertHoursTransaction,
  upsertLesson,
  upsertStudent,
  type SyncState,
} from './student-sync'
import type { Page } from './types'

// Bound each cron tick. With 200 rows/page this is up to 5000 rows per run; the
// first (full backfill) pass resumes from the persisted cursor on the next tick.
const MAX_PAGES_PER_RUN = 25

interface PullSummary {
  processed: number
  pages: number
  drained: boolean
}

async function runResourcePull<T extends { updatedAt: Date }>(
  resource: string,
  fetchPage: (q: { updatedSince: Date | null; cursor: string | null }) => Promise<Page<T>>,
  processItem: (item: T) => Promise<void>,
): Promise<PullSummary> {
  const row = await db.bookingSyncCursor.findUnique({ where: { resource } })
  const state: SyncState = {
    updatedSince: row?.updatedSince ?? null,
    cursor: row?.cursor ?? null,
  }

  const res = await drainIncremental({ state, maxPages: MAX_PAGES_PER_RUN, fetchPage, processItem })

  const cursorData = {
    updatedSince: res.newState.updatedSince,
    cursor: res.newState.cursor,
    lastRunAt: new Date(),
  }
  await db.bookingSyncCursor.upsert({
    where: { resource },
    create: { resource, ...cursorData },
    update: cursorData,
  })

  return { processed: res.processed, pages: res.pages, drained: res.drained }
}

async function auditSyncRun(jobId: string, summary: PullSummary): Promise<void> {
  // One summary audit row per run — never per imported row (CLAUDE.md §17.1).
  await writeAuditLogEntry(db, {
    actorId: null,
    action: `booking.sync:${jobId}`,
    target: { type: 'system', id: jobId },
    after: summary,
    purpose: `system:${jobId}`,
  })
}

export const bookingSyncStudents = inngest.createFunction(
  {
    id: 'booking/sync-students',
    name: 'Booking: pull changed students',
    concurrency: { limit: 2 },
    retries: 3,
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    if (!isConfigured()) {
      logger.info('booking sync skipped — BOOKING_API_TOKEN not set')
      return { skipped: true }
    }
    const summary = await step.run('pull-students', async () => {
      const client = createClient()
      return runResourcePull(
        'students',
        (q) => client.listStudents(q),
        async (s) => {
          await upsertStudent(db, s)
        },
      )
    })
    await step.run('audit', () => auditSyncRun('booking/sync-students', summary))
    logger.info(summary, 'booking sync (students) complete')
    return summary
  },
)

export const bookingSyncLessons = inngest.createFunction(
  {
    id: 'booking/sync-lessons',
    name: 'Booking: pull changed lessons',
    concurrency: { limit: 2 },
    retries: 3,
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    if (!isConfigured()) {
      logger.info('booking sync skipped — BOOKING_API_TOKEN not set')
      return { skipped: true }
    }
    const summary = await step.run('pull-lessons', async () => {
      const client = createClient()
      return runResourcePull(
        'lessons',
        (q) => client.listLessons(q),
        async (l) => {
          await upsertLesson(db, l)
        },
      )
    })
    await step.run('audit', () => auditSyncRun('booking/sync-lessons', summary))
    logger.info(summary, 'booking sync (lessons) complete')
    return summary
  },
)

export const bookingSyncBalanceLedger = inngest.createFunction(
  {
    id: 'booking/sync-balance-ledger',
    name: 'Booking: pull hours-balance ledger',
    concurrency: { limit: 2 },
    retries: 3,
  },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    if (!isConfigured()) {
      logger.info('booking sync skipped — BOOKING_API_TOKEN not set')
      return { skipped: true }
    }
    const summary = await step.run('pull-balance', async () => {
      const client = createClient()
      return runResourcePull(
        'balance_transactions',
        (q) => client.listBalanceTransactions(q),
        async (t) => {
          await upsertHoursTransaction(db, t)
        },
      )
    })
    await step.run('audit', () => auditSyncRun('booking/sync-balance-ledger', summary))
    logger.info(summary, 'booking sync (balance ledger) complete')
    return summary
  },
)

export const bookingSyncCreditLedger = inngest.createFunction(
  {
    id: 'booking/sync-credit-ledger',
    name: 'Booking: pull credit ledger',
    concurrency: { limit: 2 },
    retries: 3,
  },
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    if (!isConfigured()) {
      logger.info('booking sync skipped — BOOKING_API_TOKEN not set')
      return { skipped: true }
    }
    const summary = await step.run('pull-credits', async () => {
      const client = createClient()
      return runResourcePull(
        'credit_transactions',
        (q) => client.listCreditTransactions(q),
        async (t) => {
          await upsertCreditTransaction(db, t)
        },
      )
    })
    await step.run('audit', () => auditSyncRun('booking/sync-credit-ledger', summary))
    logger.info(summary, 'booking sync (credit ledger) complete')
    return summary
  },
)

export const FUNCTIONS = [
  bookingSyncStudents,
  bookingSyncLessons,
  bookingSyncBalanceLedger,
  bookingSyncCreditLedger,
] as const

export const JOBS: readonly { id: string; description: string }[] = [
  {
    id: 'booking/sync-students',
    description: 'Pull changed students from booking.studymind.co.uk',
  },
  { id: 'booking/sync-lessons', description: 'Pull changed lessons from booking.studymind.co.uk' },
  { id: 'booking/sync-balance-ledger', description: 'Pull the hours-balance ledger' },
  { id: 'booking/sync-credit-ledger', description: 'Pull the credit ledger' },
]
