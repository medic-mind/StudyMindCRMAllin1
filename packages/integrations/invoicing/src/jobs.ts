// Inngest functions for the invoicing integration. CLAUDE.md §7.1, §17.
//
//   invoicing/event.received     — process one inbound webhook (async, like
//                                  every other provider). Skips source==='api'
//                                  to avoid re-applying our own writes.
//   invoicing/reconcile          — nightly catch-up via the events pull-feed
//                                  (GET /api/v1/events?since=<cursor>), the
//                                  backstop for any webhook the receiver missed.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientFromConfig } from './client'
import { loadInvoicingConfig, saveEventsCursor } from './config'
import { importBusinessAccountsFromInvoicing } from './import-accounts'
import {
  deletePaymentByInvoicingId,
  softDeleteCustomerByInvoicingId,
  softDeleteInvoiceByInvoicingId,
  upsertCustomerFromRecord,
  upsertInvoiceFromRecord,
  upsertPaymentFromRecord,
} from './sync'
import { mapCustomerCategory, mapEntityType, mapEventSource, RawCustomer, RawEvent } from './types'

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
  const action = actionFromTopic(event.action ?? dataObj?.action ?? event.type)
  const recordId = recordIdOf(record)

  switch (entityType) {
    case 'partner': {
      // AP/council clients are invoicing-only — explicitly ack-and-drop rather
      // than pollute the CRM (same pattern as task/student). b2b + b2c are
      // mirrored; b2b additionally feeds the accounts backfill/classifier.
      const cat = mapCustomerCategory(RawCustomer.safeParse(record).data?.category)
      if (cat === 'alt_provision') {
        return { applied: false, reason: 'acknowledged_not_mirrored:alt_provision' }
      }
      if (action === 'deleted' && recordId) {
        await softDeleteCustomerByInvoicingId(db, recordId)
        return { applied: true, reason: 'partner_deleted' }
      }
      await upsertCustomerFromRecord(db, record, source)
      return { applied: true, reason: 'partner' }
    }
    case 'invoice':
    case 'invoice_line_item':
      if (action === 'deleted' && entityType === 'invoice' && recordId) {
        await softDeleteInvoiceByInvoicingId(db, recordId)
        return { applied: true, reason: 'invoice_deleted' }
      }
      await upsertInvoiceFromRecord(db, record, source)
      return { applied: true, reason: 'invoice' }
    case 'payment':
      if (action === 'deleted' && recordId) {
        const r = await deletePaymentByInvoicingId(db, recordId)
        return { applied: r.deleted, reason: r.deleted ? 'payment_deleted' : 'payment_not_mirrored' }
      }
      await upsertPaymentFromRecord(db, record, source)
      return { applied: true, reason: 'payment' }
    case 'task':
    case 'student':
      // Intentionally not mirrored in this slice. The CRM already models these
      // first-class (Task, and BusinessAccountStudent), so we deliberately
      // acknowledge-and-drop rather than leave them as "unhandled" in the
      // platform's delivery log. The route still returns 200, so the platform
      // will not retry.
      // TODO(invoicing, follow-up): wire these two entities. For students the
      // CRM is the source of truth, so the intended flow is CRM → invoicing
      // (push), not invoicing → CRM. Tasks map to the CRM Task model.
      return { applied: false, reason: `acknowledged_not_mirrored:${entityType}` }
    default:
      // Genuinely unknown entity_type. Acknowledged (200 at the route) so the
      // channel does not retry forever; surfaced via the return tag + log so a
      // new platform entity shows up in our observability rather than silently.
      return { applied: false, reason: `unknown_entity:${entityType}` }
  }
}

/** Derive an entity type from a `entity.action` topic string ("invoice.created"). */
function typeFromTopic(type: string | null | undefined): string | undefined {
  if (!type) return undefined
  return type.split('.')[0]
}

/** Derive the action from an `entity.action` topic or a bare action string. */
function actionFromTopic(value: string | null | undefined): string | undefined {
  if (!value) return undefined
  return value.includes('.') ? value.split('.').slice(1).join('.') : value
}

/** Pull the platform id out of a record for delete events (the record may be a
 *  full row or a stub like `{ id }`). */
function recordIdOf(record: unknown): string | null {
  if (record && typeof record === 'object' && 'id' in record) {
    const id = (record as { id: unknown }).id
    if (typeof id === 'string' && id) return id
    if (typeof id === 'number') return String(id)
  }
  return null
}

export const invoicingEventReceived = inngest.createFunction(
  {
    id: 'invoicing/event.received',
    name: 'Process B2B invoicing webhook event',
    concurrency: { limit: 5 },
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
  // Every 2 minutes so the CRM tracks the platform closely even if a webhook is
  // missed. This is only a SAFETY NET — live changes already arrive within ~1s
  // via webhooks. A tighter interval (e.g. 10s) would be wasteful: thousands of
  // redundant API calls/day for changes that already landed by webhook, and it
  // would rate-limit against the platform. The manual "Sync now" path covers
  // on-demand freshness. Each run walks forward from the cursor and stops as
  // soon as it catches up (usually 0 new events).
  [{ cron: '*/2 * * * *' }, { event: 'invoicing/reconcile.requested' }],
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

/**
 * Admin-triggered backfill: pull every B2B customer into real CRM School /
 * B2B Partner accounts (deduped, classified, tray-flagged when uncertain).
 * Idempotent — safe to re-run. Concurrency 1 so two clicks don't race.
 */
interface ImportRequestedData {
  actorId?: string | null
  requestId?: string
}

export const invoicingAccountsImport = inngest.createFunction(
  {
    id: 'invoicing/accounts.import',
    name: 'Import B2B customers into CRM accounts',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { event: 'invoicing/accounts.import.requested' },
  async ({ event, step, logger }) => {
    const data = (event.data ?? {}) as ImportRequestedData

    const cfg = await step.run('load-config', async () => loadInvoicingConfig())
    if (!cfg.apiKey) {
      logger.warn({}, 'invoicing.accounts.import.skipped: not configured')
      return { skipped: true, reason: 'not_configured' }
    }

    // The import is one logical unit (it paginates + reconciles); run it inside
    // a single step so a retry re-runs the whole idempotent pass.
    const result = await step.run('import', async () =>
      importBusinessAccountsFromInvoicing(db, {
        ctx: {
          actorId: data.actorId ?? null,
          requestId: data.requestId ?? `invoicing-import:${event.id ?? 'manual'}`,
        },
      }),
    )

    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: data.actorId ?? null,
        action: 'invoicing.accounts_imported',
        target: { type: 'InvoicingSetting', id: 'default' },
        requestId: data.requestId,
        after: result,
      })
    })

    logger.info(result, 'invoicing.accounts.import.completed')
    return result
  },
)

export const FUNCTIONS = [
  invoicingEventReceived,
  invoicingReconcile,
  invoicingAccountsImport,
] as const
