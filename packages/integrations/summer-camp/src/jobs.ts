// Inngest functions for the Summer Camp integration. CLAUDE.md §7.1, §17.
//
//   summer-camp/event.received — process one inbound booking webhook async.
//   Loads the persisted ProviderEvent, re-parses the envelope, and applies the
//   enrichment (match/create contacts, link, timeline interaction, audit). The
//   apply step is idempotent, so an Inngest retry is safe.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { applyBookingEvent } from './apply'
import { type BookingsPage, createClientFromConfig } from './client'
import { BookingEventEnvelope, BookingResource, type BookingEventType } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

const PULL_PAGE_SIZE = 200
/** Cron lookback window — how far back the periodic sync re-pulls each tick.
 *  Idempotent, so overlap is cheap; this only needs to exceed the gap between
 *  ticks plus any plausible webhook outage. */
const SYNC_LOOKBACK_DAYS = Number(process.env['SUMMER_CAMP_SYNC_LOOKBACK_DAYS'] ?? '3')

/** Synthesize an envelope for a pulled booking (no webhook). The event type is
 *  derived from status; the id is deterministic per booking-state so the
 *  interaction + audit upserts stay idempotent across re-pulls. */
function synthesizeEnvelope(b: BookingResource): BookingEventEnvelope {
  const ms = b.updated_at ? new Date(b.updated_at).getTime() : Date.now()
  const stamp = Number.isFinite(ms) ? ms : 0
  const type: BookingEventType =
    b.status === 'cancelled' ? 'summer_camp.booking.cancelled' : 'summer_camp.booking.updated'
  return { id: `${b.id}:${type}:${stamp}`, type, occurred_at: new Date().toISOString(), site: null, booking: b }
}

/** Apply one pulled page; returns how many parsed + applied. Pull path never
 *  audits per booking (audit:false) — see ApplyOptions. */
async function applyPage(bookings: unknown[]): Promise<number> {
  let applied = 0
  for (const raw of bookings) {
    const parsed = BookingResource.safeParse(raw)
    if (!parsed.success) continue
    await applyBookingEvent(db, synthesizeEnvelope(parsed.data), { audit: false })
    applied += 1
  }
  return applied
}

export const summerCampEventReceived = inngest.createFunction(
  {
    id: 'summer-camp/event.received',
    name: 'Process Summer Camp booking webhook event',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'summer-camp/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId } = data

    const providerEvent = await step.run('load-event', async () => {
      return db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
    })

    const result = await step.run('apply', async () => {
      const parsed = BookingEventEnvelope.safeParse(providerEvent.raw)
      if (!parsed.success) return { action: 'skipped' as const, reason: 'unparseable' }
      return applyBookingEvent(db, parsed.data)
    })

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    logger.info({ eventId, ...result }, 'summer_camp.event.processed')
    return { eventId, ...result }
  },
)

/**
 * One-shot backfill of ALL current camp bookings. Admin-triggered
 * (`summer-camp/backfill-bookings.requested`). Walks the camp app's keyset
 * feed page-by-page, self-rescheduling with the cursor in the event payload —
 * so a single event id covers the whole walk. Idempotent (apply upserts), so a
 * retry or re-run converges. concurrency:1 → the function id is the advisory
 * lock; two runners can't race. Per-booking writes are NOT audited; one
 * summary audit row is written on completion (CLAUDE.md §17).
 */
export const summerCampBackfillBookings = inngest.createFunction(
  {
    id: 'summer-camp/backfill-bookings',
    name: 'Backfill all Summer Camp bookings',
    concurrency: { limit: 1 },
    retries: 4,
  },
  { event: 'summer-camp/backfill-bookings.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as { jobId: string; cursor?: string | null; processed?: number }
    const client = createClientFromConfig()
    if (!client) {
      logger.warn({}, 'summer_camp.backfill.skipped: not configured')
      return { skipped: true, reason: 'not_configured' }
    }

    const cursor = data.cursor ?? null
    const processedSoFar = data.processed ?? 0

    const page = await step.run('fetch', async () =>
      client.getBookings({ cursor, limit: PULL_PAGE_SIZE }),
    )
    const applied = await applyPage(page.bookings)
    const processed = processedSoFar + applied

    if (page.nextCursor) {
      await step.sendEvent('schedule-next-page', {
        name: 'summer-camp/backfill-bookings.requested',
        data: { jobId: data.jobId, cursor: page.nextCursor, processed },
      })
      return { applied, processed, done: false }
    }

    await step.run('audit-complete', async () =>
      writeAuditLogEntry(db, {
        actorId: null,
        action: 'summer_camp.bookings_synced',
        target: { type: 'System', id: data.jobId },
        requestId: data.jobId,
        after: { mode: 'backfill', processed },
      }),
    )
    logger.info({ jobId: data.jobId, processed }, 'summer_camp.backfill.done')
    return { applied, processed, done: true }
  },
)

/**
 * Recurring safety-net sync (every 15 min). Re-pulls bookings changed in the
 * last SYNC_LOOKBACK_DAYS and applies them idempotently, catching anything a
 * live webhook missed (and importing new bookings even if the push is not
 * configured). No-op when the camp feed isn't configured. Reconciliation, so
 * it logs counts rather than auditing per booking (the live webhook is the
 * per-booking audit source).
 */
export const summerCampSyncBookings = inngest.createFunction(
  {
    id: 'summer-camp/sync-bookings',
    name: 'Sync recent Summer Camp bookings',
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ cron: '*/15 * * * *' }, { event: 'summer-camp/sync-bookings.requested' }],
  async ({ step, logger }) => {
    const client = createClientFromConfig()
    if (!client) {
      logger.warn({}, 'summer_camp.sync.skipped: not configured')
      return { skipped: true, reason: 'not_configured' }
    }

    const since = new Date(Date.now() - SYNC_LOOKBACK_DAYS * 86_400_000).toISOString()
    let cursor: string | null = null
    let applied = 0
    let pages = 0
    const MAX_PAGES = 25 // safety bound: 25 * 200 = 5k recently-changed bookings

    while (pages < MAX_PAGES) {
      const batchCursor: string | null = cursor
      const page: BookingsPage = await step.run(`fetch-${pages}`, async () =>
        client.getBookings({ since, cursor: batchCursor, limit: PULL_PAGE_SIZE }),
      )
      applied += await applyPage(page.bookings)
      pages += 1
      if (page.nextCursor) cursor = page.nextCursor
      else break
    }

    logger.info({ since, applied, pages }, 'summer_camp.sync.done')
    return { applied, pages, since }
  },
)

export const FUNCTIONS = [
  summerCampEventReceived,
  summerCampBackfillBookings,
  summerCampSyncBookings,
]
