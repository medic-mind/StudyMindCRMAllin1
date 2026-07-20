// Inngest functions for the Summer Camp integration. CLAUDE.md §7.1, §17.
//
//   summer-camp/event.received — process one inbound booking webhook async.
//   Loads the persisted ProviderEvent, re-parses the envelope, and applies the
//   enrichment (match/create contacts, link, timeline interaction, audit). The
//   apply step is idempotent, so an Inngest retry is safe.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createId } from '@paralleldrive/cuid2'

import { keywordLabel, splitBillingName, type CampPurchaseKeyword } from '@studymind/core/camp'

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
async function applyPage(bookings: unknown[], syncSource: string): Promise<number> {
  let applied = 0
  for (const raw of bookings) {
    const parsed = BookingResource.safeParse(raw)
    if (!parsed.success) continue
    await applyBookingEvent(db, synthesizeEnvelope(parsed.data), { audit: false, syncSource })
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
    const applied = await applyPage(page.bookings, 'backfill')
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
      applied += await applyPage(page.bookings, 'sync')
      pages += 1
      if (page.nextCursor) cursor = page.nextCursor
      else break
    }

    // Tombstone pass. A booking deleted in the camp app simply vanishes from
    // the since-feed (which structurally cannot emit "gone" rows), and the
    // camp's delete webhook is best-effort — so walk the FULL current id set
    // and mark mirror rows that no longer exist camp-side as cancelled. Only
    // runs when the walk completes inside the page bound (never tombstone on
    // partial data), and skips rows synced after the sweep started (a booking
    // created mid-sweep must not be cancelled by it).
    const sweepStartedAt = new Date()
    const liveIds = new Set<string>()
    let sweepCursor: string | null = null
    let sweepPages = 0
    let sweepComplete = false
    while (sweepPages < MAX_PAGES) {
      const batchCursor: string | null = sweepCursor
      const page: BookingsPage = await step.run(`sweep-${sweepPages}`, async () =>
        client.getBookings({ cursor: batchCursor, limit: PULL_PAGE_SIZE }),
      )
      for (const b of page.bookings) {
        const id = (b as { id?: unknown } | null)?.id
        if (typeof id === 'string') liveIds.add(id)
      }
      sweepPages += 1
      if (page.nextCursor) sweepCursor = page.nextCursor
      else {
        sweepComplete = true
        break
      }
    }
    let tombstoned = 0
    if (sweepComplete) {
      tombstoned = await step.run('tombstone-missing', async () => {
        const live = await db.campBookingRecord.findMany({
          where: {
            deletedAt: null,
            OR: [{ status: null }, { status: { not: 'cancelled' } }],
            lastSyncedAt: { lt: sweepStartedAt },
          },
          select: { externalBookingId: true },
        })
        const gone = live.map((r) => r.externalBookingId).filter((id) => !liveIds.has(id))
        if (gone.length === 0) return 0
        const res = await db.campBookingRecord.updateMany({
          where: { externalBookingId: { in: gone } },
          data: { status: 'cancelled', lastSyncedAt: new Date(), lastSyncSource: 'sync_tombstone' },
        })
        return res.count
      })
    }

    logger.info({ since, applied, pages, tombstoned }, 'summer_camp.sync.done')
    return { applied, pages, since, tombstoned }
  },
)

interface PurchaseDetectedData {
  stripeChargeId: string
  stripePaymentIntentId?: string | null
  amountMinor: number
  currency?: string
  customerName?: string | null
  customerEmail?: string | null
  productText?: string | null
  matchedKeyword: CampPurchaseKeyword
  occurredAt?: string | null
}

/**
 * A Stripe charge matched "summer camp" / "work experience": record it as a
 * CampStripePurchase (idempotent on the charge id) and AUTO-CREATE the camp
 * booking through the CRM (POST /api/external/bookings — itself idempotent on
 * payment.reference = the charge id, so retries never duplicate). The created
 * booking is applied locally at once (contacts + timeline + CampBookingRecord).
 * Rows that cannot auto-create (camp app not connected, no billing name) stay
 * `pending` with the reason and surface in the /camps/purchases review tray.
 */
export const summerCampPurchaseDetected = inngest.createFunction(
  {
    id: 'summer-camp/purchase.detected',
    name: 'Summer Camp Stripe purchase -> camp booking',
    // Serialise per charge: the same charge can be emitted by the live
    // charge.succeeded path, the historic scan, and a tray Retry — runs for
    // one charge must queue behind each other so the record/skip check is
    // race-free (the camp-side payment.reference dedupe is the second line).
    concurrency: [{ limit: 2 }, { limit: 1, key: 'event.data.stripeChargeId' }],
    retries: 4,
  },
  { event: 'summer-camp/purchase.detected' },
  async ({ event, step, logger }) => {
    const data = event.data as unknown as PurchaseDetectedData
    if (!data?.stripeChargeId || !data.matchedKeyword) {
      return { skipped: true, reason: 'malformed_event' }
    }

    // 1. Record the purchase (idempotent on the charge id). Never overwrite a
    //    row a human already resolved or dismissed.
    const purchase = await step.run('record', async () => {
      const existing = await db.campStripePurchase.findUnique({
        where: { stripeChargeId: data.stripeChargeId },
        select: { id: true, status: true, externalBookingId: true },
      })
      if (existing) return existing
      const created = await db.campStripePurchase.create({
        data: {
          id: createId(),
          stripeChargeId: data.stripeChargeId,
          stripePaymentIntentId: data.stripePaymentIntentId ?? null,
          amountMinor: data.amountMinor,
          currency: (data.currency ?? 'gbp').toLowerCase(),
          customerName: data.customerName ?? null,
          customerEmail: data.customerEmail ?? null,
          productText: data.productText ?? null,
          matchedKeyword: data.matchedKeyword,
          occurredAt: data.occurredAt ? new Date(data.occurredAt) : null,
          createdById: 'system:stripe',
        },
        select: { id: true, status: true, externalBookingId: true },
      })
      await writeAuditLogEntry(db, {
        actorId: 'system:stripe',
        action: 'summer_camp.purchase_detected',
        target: { type: 'CampStripePurchase', id: created.id },
        requestId: `camp-purchase:${data.stripeChargeId}`,
        after: {
          stripeChargeId: data.stripeChargeId,
          amountMinor: data.amountMinor,
          matchedKeyword: data.matchedKeyword,
        },
      })
      return created
    })

    if (purchase.status === 'booking_created' || purchase.status === 'dismissed') {
      return { skipped: true, reason: purchase.status, purchaseId: purchase.id }
    }

    // 2. Create the camp booking through the CRM.
    const client = createClientFromConfig()
    if (!client) {
      await step.run('mark-not-connected', async () => {
        await db.campStripePurchase.update({
          where: { id: purchase.id },
          data: { error: 'Summer Camp app not connected — connect it, then Retry from the tray.' },
        })
      })
      return { pending: true, reason: 'not_configured', purchaseId: purchase.id }
    }

    // The camp app records money in GBP only — a non-GBP amount written into
    // its pounds columns at face value would be silently wrong. Leave the row
    // pending for a human to enter manually.
    const chargeCurrency = (data.currency ?? 'gbp').toLowerCase()
    if (chargeCurrency !== 'gbp') {
      await step.run('mark-non-gbp', async () => {
        await db.campStripePurchase.update({
          where: { id: purchase.id },
          data: {
            error: `Charge is in ${chargeCurrency.toUpperCase()} — the camp app records GBP only. Create the booking manually.`,
          },
        })
      })
      return { pending: true, reason: 'non_gbp', purchaseId: purchase.id }
    }

    const name = splitBillingName(data.customerName)
    if (!name) {
      await step.run('mark-no-name', async () => {
        await db.campStripePurchase.update({
          where: { id: purchase.id },
          data: { error: 'No customer name on the Stripe charge — complete it from the tray.' },
        })
      })
      return { pending: true, reason: 'no_name', purchaseId: purchase.id }
    }

    const created = await step.run('create-booking', async () => {
      try {
        return await client.createBooking({
          student: { first_name: name.firstName, last_name: name.lastName, email: data.customerEmail ?? null },
          guardian: { name: data.customerName ?? null, email: data.customerEmail ?? null },
          subject: keywordLabel(data.matchedKeyword),
          booking_type: 'b2c',
          status: 'confirmed',
          payment: {
            total_minor: data.amountMinor,
            paid_minor: data.amountMinor,
            type: 'Stripe',
            reference: data.stripeChargeId,
          },
          agent_name: 'CRM (Stripe auto)',
          notes: `Auto-created from Stripe payment ${data.stripeChargeId}${data.productText ? ` - ${data.productText}` : ''}. Confirm the student details and assign a camp.`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'camp app rejected the booking'
        await db.campStripePurchase.update({
          where: { id: purchase.id },
          data: { error: message },
        })
        // Rethrow so Inngest retries transient failures; the row stays
        // pending (with the reason) if retries exhaust.
        throw err
      }
    })

    // 3. Mirror the created booking locally (contacts + timeline + record).
    const outcome = await step.run('apply-locally', async () => {
      const parsed = BookingResource.safeParse(created.booking)
      if (!parsed.success) return { bookingId: null as string | null, contactId: null as string | null }
      const result = await applyBookingEvent(db, synthesizeEnvelope(parsed.data), {
        audit: false,
        syncSource: 'crm_create',
      })
      return { bookingId: parsed.data.id, contactId: result.primaryContactId }
    })

    if (!outcome.bookingId) {
      // The camp accepted the POST but the response didn't parse — the booking
      // may exist camp-side. Stay pending so Retry can reconcile: a re-POST
      // dedupes on payment.reference and returns the existing booking.
      await step.run('mark-unparsed-response', async () => {
        await db.campStripePurchase.update({
          where: { id: purchase.id },
          data: { error: 'Camp app response could not be read — use Retry to reconcile the booking link.' },
        })
      })
      return { pending: true, reason: 'unparsed_response', purchaseId: purchase.id }
    }

    await step.run('finalise', async () => {
      // Conditional update: a human may have dismissed the row while this run
      // was in flight — honour that decision (the camp booking still exists
      // and will mirror via the normal sync; only the tray row stays put).
      const updated = await db.campStripePurchase.updateMany({
        where: { id: purchase.id, status: { not: 'dismissed' } },
        data: {
          status: 'booking_created',
          externalBookingId: outcome.bookingId,
          contactId: outcome.contactId,
          error: null,
          updatedById: 'system:stripe',
        },
      })
      if (updated.count === 0) return
      await writeAuditLogEntry(db, {
        actorId: 'system:stripe',
        action: 'summer_camp.booking_created_from_stripe',
        target: { type: 'CampStripePurchase', id: purchase.id },
        requestId: `camp-booking-from-stripe:${data.stripeChargeId}`,
        after: {
          stripeChargeId: data.stripeChargeId,
          externalBookingId: outcome.bookingId,
          deduped: created.deduped,
        },
      })
    })

    logger.info(
      { chargeId: data.stripeChargeId, bookingId: outcome.bookingId, deduped: created.deduped },
      'summer_camp.purchase.processed',
    )
    return { ok: true, purchaseId: purchase.id, bookingId: outcome.bookingId }
  },
)

export const FUNCTIONS = [
  summerCampEventReceived,
  summerCampBackfillBookings,
  summerCampSyncBookings,
  summerCampPurchaseDetected,
]
