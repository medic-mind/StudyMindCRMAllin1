// Inngest functions for the invoicing integration. CLAUDE.md §7.1, §17.
//
//   invoicing/event.received     — process one inbound webhook (async, like
//                                  every other provider). Skips source==='api'
//                                  to avoid re-applying our own writes.
//   invoicing/reconcile          — nightly catch-up via the events pull-feed
//                                  (GET /api/v1/events?since=<cursor>), the
//                                  backstop for any webhook the receiver missed.

import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientFromConfig } from './client'
import { loadInvoicingConfig, saveEventsCursor } from './config'
import { upsertCustomerFromRecord, upsertInvoiceFromRecord, upsertPaymentFromRecord } from './sync'
import { mapEntityType, mapEventSource, RawEvent } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

/**
 * Apply a single platform event (from webhook or feed) to the mirror. Returns
 * a short tag for logging. Skips events caused by our own API writes so we do
 * not re-apply (and re-audit) work we already did synchronously.
 */
async function applyEvent(raw: unknown): Promise<{ applied: boolean; reason: string }> {
  const parsed = RawEvent.safeParse(raw)
  if (!parsed.success) return { applied: false, reason: 'unparseable' }
  const event = parsed.data

  const source = mapEventSource(event.source)
  if (source === 'api') {
    // Our own outbound write already mirrored this synchronously.
    return { applied: false, reason: 'self_origin_api' }
  }

  // The record may sit at `record` or under `data.record` depending on channel
  // (webhook nests it under `data`). Normalise both.
  const dataObj = (event as { data?: unknown }).data as
    | { record?: unknown; entity_type?: string; action?: string }
    | undefined
  const record = event.record ?? dataObj?.record ?? null
  if (record === null || record === undefined) {
    return { applied: false, reason: 'no_record' }
  }

  const entityType = mapEntityType(
    event.entity_type ?? dataObj?.entity_type ?? typeFromTopic(event.type),
  )

  switch (entityType) {
    case 'partner':
      await upsertCustomerFromRecord(db, record, source)
      return { applied: true, reason: 'partner' }
    case 'invoice':
    case 'invoice_line_item':
      await upsertInvoiceFromRecord(db, record, source)
      return { applied: true, reason: 'invoice' }
    case 'payment':
      await upsertPaymentFromRecord(db, record, source)
      return { applied: true, reason: 'payment' }
    default:
      // task / student / unknown — not mirrored in this slice. Acknowledged so
      // the channel does not retry forever; surfaced via the return tag.
      return { applied: false, reason: `entity_not_mirrored:${entityType}` }
  }
}

/** Derive an entity type from a `entity.action` topic string ("invoice.created"). */
function typeFromTopic(type: string | null | undefined): string | undefined {
  if (!type) return undefined
  return type.split('.')[0]
}

export const invoicingEventReceived = inngest.createFunction(
  {
    id: 'invoicing/event.received',
    name: 'Process B2B invoicing webhook event',
    concurrency: { limit: 10 },
    retries: 6,
  },
  { event: 'invoicing/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId } = data

    const providerEvent = await step.run('load-event', async () => {
      return db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
    })

    const result = await step.run('apply', async () => applyEvent(providerEvent.raw))

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    logger.info({ eventId, ...result }, 'invoicing.event.processed')
    return { eventId, ...result }
  },
)

/**
 * Nightly reconcile via the events pull-feed. Walks forward from the persisted
 * cursor, applies each event idempotently (the same `applyEvent` the webhook
 * uses), and saves the cursor as it goes so a crash resumes without gaps.
 */
export const invoicingReconcile = inngest.createFunction(
  {
    id: 'invoicing/reconcile',
    name: 'Reconcile B2B invoicing via events feed',
    concurrency: { limit: 1 },
    retries: 3,
  },
  [{ cron: '0 1 * * *' }, { event: 'invoicing/reconcile.requested' }],
  async ({ step, logger }) => {
    const cfg = await step.run('load-config', async () => loadInvoicingConfig())
    if (!cfg.apiKey) {
      logger.warn({}, 'invoicing.reconcile.skipped: not configured')
      return { skipped: true, reason: 'not_configured' }
    }

    let cursor = cfg.eventsCursor ?? '0'
    let applied = 0
    let scanned = 0
    let pages = 0
    const MAX_PAGES = 100 // safety bound: 100 * 100 = 10k events per run

    while (pages < MAX_PAGES) {
      const batchCursor = cursor
      const batch = await step.run(`fetch-${pages}`, async () => {
        const client = await createClientFromConfig()
        return client.getEvents(batchCursor, { limit: 100 })
      })

      if (batch.data.length === 0) break

      const batchResult = await step.run(`apply-${pages}`, async () => {
        let localApplied = 0
        for (const ev of batch.data) {
          const r = await applyEvent(ev)
          if (r.applied) localApplied += 1
        }
        return { localApplied, count: batch.data.length }
      })
      applied += batchResult.localApplied
      scanned += batchResult.count

      if (batch.next_cursor) {
        cursor = batch.next_cursor
        await step.run(`save-cursor-${pages}`, async () => saveEventsCursor(cursor))
      }

      pages += 1
      if (!batch.has_more) break
    }

    logger.info({ applied, scanned, pages, cursor }, 'invoicing.reconcile.completed')
    return { applied, scanned, pages, cursor }
  },
)

export const FUNCTIONS = [invoicingEventReceived, invoicingReconcile] as const
