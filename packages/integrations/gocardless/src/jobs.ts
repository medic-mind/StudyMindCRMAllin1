// Inngest functions triggered after a GoCardless webhook lands.
// CLAUDE.md §7.1 (handler stays thin), §9 (refetch — webhook payloads are
// notifications), §17 (concurrency, granular step.run, idempotency).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  linkReplacedMandate,
  recomputeAtRiskForFamily,
  resolveFamilyByGcMandate,
  revertGcPayment,
  syncGcMandate,
  syncGcPayment,
} from '@studymind/core/finance'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import { mapMandateStatus, mapPaymentStatus } from './types'

// Event keys we currently process (resource_type/action). Anything else is
// logged and skipped (no error) so unrecognised webhook types do not blow up
// the dead-letter queue.
const HANDLED_KEYS = new Set<string>([
  'payments/confirmed',
  'payments/failed',
  'payments/late_failure_settled',
  'mandates/active',
  'mandates/cancelled',
  'mandates/replaced',
])

interface GcEventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

export const gocardlessEventReceived = inngest.createFunction(
  {
    id: 'gocardless/event.received',
    name: 'Process GoCardless webhook event',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'gocardless/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as GcEventReceivedData
    const { eventId, providerEventRowId, type } = data

    if (!HANDLED_KEYS.has(type)) {
      logger.info({ eventId, type }, 'gocardless event type not handled — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'type_not_handled' }
    }

    // 1. Read the stored ProviderEvent payload — we need event.links to know
    //    which canonical resource(s) to refetch. The raw payload is the only
    //    fact we trust about the event itself; we still refetch the
    //    referenced object from GoCardless for state.
    const providerEvent = await step.run('load-event', async () => {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true, type: true },
      })
      return row
    })

    const rawEvent = providerEvent.raw as {
      id: string
      action: string
      resource_type: string
      created_at: string
      links: { mandate?: string; payment?: string; new_mandate?: string }
    }
    const occurredAt = new Date(rawEvent.created_at)

    const isPayment = type.startsWith('payments/')
    const isMandate = type.startsWith('mandates/')

    // 2. Refetch the canonical resource. CLAUDE.md §9.
    const refetched = await step.run('refetch', async () => {
      const client = createClient()
      if (isPayment && rawEvent.links.payment) {
        const payment = await client.getPayment(rawEvent.links.payment)
        return { kind: 'payment' as const, payment }
      }
      if (isMandate && rawEvent.links.mandate) {
        const mandate = await client.getMandate(rawEvent.links.mandate)
        // For replaced mandates, also fetch the new one so we can persist it.
        let newMandate = null
        if (rawEvent.action === 'replaced' && rawEvent.links.new_mandate) {
          newMandate = await client.getMandate(rawEvent.links.new_mandate)
        }
        return { kind: 'mandate' as const, mandate, newMandate }
      }
      return { kind: 'unresolvable' as const }
    })

    if (refetched.kind === 'unresolvable') {
      logger.warn({ eventId, type }, 'gocardless event missing canonical link — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'missing_canonical_link' }
    }

    // 3. Persist into our normalised mirror tables and run any side-effects.
    const persisted = await step.run('persist', async () => {
      if (refetched.kind === 'payment') {
        const p = refetched.payment
        const mandateId = p.links.mandate
        if (!mandateId) {
          return {
            kind: 'payment' as const,
            unresolved: true,
            familyId: null as string | null,
            gcId: p.id,
            status: mapPaymentStatus(p.status),
            reversal: null as { reopenedAllocations: number } | null,
          }
        }
        const mappedStatus = mapPaymentStatus(p.status)
        const isConfirmed = mappedStatus === 'confirmed'
        const sync = await syncGcPayment(db, {
          gcPaymentId: p.id,
          gcMandateId: mandateId,
          amountMinor: p.amount,
          currency: p.currency.toUpperCase(),
          receivedAt: new Date(p.created_at),
          confirmedAt: isConfirmed ? occurredAt : undefined,
        })

        // Late-failure reversal — CLAUDE.md §9.
        let reversal: { reopenedAllocations: number } | null = null
        if (rawEvent.action === 'late_failure_settled') {
          const r = await revertGcPayment(db, { gcPaymentId: p.id, occurredAt })
          reversal = { reopenedAllocations: r.reopenedAllocations }
        }

        return {
          kind: 'payment' as const,
          unresolved: sync.unresolved,
          familyId: sync.familyId,
          gcId: p.id,
          status: mappedStatus,
          reversal,
        }
      }

      // mandate
      const m = refetched.mandate
      const familyId = await resolveFamilyByGcMandate(db, m.id)
      const mappedStatus = mapMandateStatus(m.status)
      const sync = await syncGcMandate(db, {
        gcMandateId: m.id,
        state: mappedStatus,
        ...(familyId ? { familyId } : {}),
      })

      // Replacement — CLAUDE.md §9.
      let replacement: { newGcMandateId: string } | null = null
      if (rawEvent.action === 'replaced' && refetched.newMandate) {
        const newM = refetched.newMandate
        const newFamilyId = familyId ?? sync.familyId
        if (newFamilyId) {
          await syncGcMandate(db, {
            gcMandateId: newM.id,
            state: mapMandateStatus(newM.status),
            familyId: newFamilyId,
          })
          await linkReplacedMandate(db, m.id, newM.id)
          replacement = { newGcMandateId: newM.id }
        }
      }

      return {
        kind: 'mandate' as const,
        unresolved: sync.unresolved,
        familyId: sync.familyId,
        gcId: m.id,
        status: mappedStatus,
        replacement,
      }
    })

    if (persisted.unresolved || !persisted.familyId) {
      logger.warn(
        { eventId, type, gcId: persisted.gcId },
        'gocardless event has no Family link yet — leaving for finance triage',
      )
      await step.run('mark-unresolved', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'unresolved_family' }
    }

    const familyId = persisted.familyId

    // 4. Append a timeline Interaction. Idempotent on (familyId, eventId).
    await step.run('interaction', async () => {
      const existing = await db.interaction.findFirst({
        where: {
          familyId,
          type: 'payment',
          payload: { path: ['gcEventId'], equals: eventId },
        },
        select: { id: true },
      })
      if (existing) return

      const summary = buildInteractionSummary(type, persisted)

      await db.interaction.create({
        data: {
          id: createId(),
          type: 'payment',
          familyId,
          occurredAt,
          summary,
          payload: {
            gcEventId: eventId,
            gcEventType: type,
            gcObjectId: persisted.gcId,
            kind: persisted.kind,
            ...(persisted.kind === 'payment' && persisted.reversal
              ? { reversal: persisted.reversal }
              : {}),
            ...(persisted.kind === 'mandate' && persisted.replacement
              ? { replacement: persisted.replacement }
              : {}),
          },
        },
      })
    })

    // 5. Audit. Idempotent via requestId == eventId.
    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: `gocardless.${type}`,
        target: { type: 'Family', id: familyId },
        requestId: eventId,
        after: {
          gcEventId: eventId,
          gcEventType: type,
          gcObjectId: persisted.gcId,
          kind: persisted.kind,
        },
      })
    })

    // 5b. Recompute at-risk for this family — late failures count as a
    // failed Direct Debit signal. CLAUDE.md §6.4.
    if (persisted.kind === 'payment') {
      await step.run('recompute-at-risk', async () => {
        await recomputeAtRiskForFamily(db, familyId, {
          requestId: `gocardless:${eventId}:at-risk`,
        })
      })
    }

    // 6. Mark the ProviderEvent processed.
    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, kind: persisted.kind }
  },
)

function buildInteractionSummary(
  type: string,
  persisted:
    | { kind: 'payment'; reversal: { reopenedAllocations: number } | null }
    | { kind: 'mandate'; replacement: { newGcMandateId: string } | null },
): string {
  if (persisted.kind === 'payment') {
    if (type === 'payments/late_failure_settled') {
      return 'GoCardless payment reverted by late failure'
    }
    if (type === 'payments/confirmed') return 'GoCardless payment confirmed'
    if (type === 'payments/failed') return 'GoCardless payment failed'
    return `GoCardless ${type}`
  }
  if (type === 'mandates/replaced') return 'GoCardless mandate replaced'
  if (type === 'mandates/active') return 'GoCardless mandate active'
  if (type === 'mandates/cancelled') return 'GoCardless mandate cancelled'
  return `GoCardless ${type}`
}

// -----------------------------------------------------------------------------
// Recurring late-failure reconcile (CLAUDE.md §17.1).
// Walks recent confirmed Payments and surfaces any new late failures we may
// have missed via webhook delivery loss.
// -----------------------------------------------------------------------------

const FOUR_DAYS_MS = 4 * 24 * 60 * 60 * 1000

export const gocardlessReconcileLateFailures = inngest.createFunction(
  {
    id: 'gocardless/reconcile-late-failures',
    name: 'GoCardless: reconcile recent confirmed payments for late failures',
    concurrency: { limit: 1 },
    retries: 3,
  },
  { cron: '0 */4 * * *' },
  async ({ step, logger }) => {
    const cutoff = await step.run('compute-cutoff', async () => {
      return new Date(Date.now() - FOUR_DAYS_MS)
    })

    const candidates = await step.run('list-candidates', async () => {
      return db.payment.findMany({
        where: {
          provider: 'gocardless',
          reverted: false,
          confirmedAt: { gte: cutoff },
        },
        select: { id: true, externalId: true, familyId: true },
        take: 500,
      })
    })

    let reverted = 0
    for (const candidate of candidates) {
      const newlyReverted = await step.run(`check-${candidate.externalId}`, async () => {
        const client = createClient()
        const fresh = await client.getPayment(candidate.externalId)
        const status = mapPaymentStatus(fresh.status)
        // If GoCardless now reports the payment as failed/charged_back, treat
        // it as a missed late failure and run the reversal flow.
        if (status === 'failed' || status === 'charged_back') {
          const result = await revertGcPayment(db, {
            gcPaymentId: candidate.externalId,
            occurredAt: new Date(),
          })
          if (result.paymentId) {
            await writeAuditLogEntry(db, {
              actorId: null,
              action: 'gocardless.reconcile.late_failure_recovered',
              target: { type: 'Family', id: candidate.familyId },
              requestId: `late-failure-recover:${candidate.externalId}`,
              after: {
                gcPaymentId: candidate.externalId,
                status,
                reopenedAllocations: result.reopenedAllocations,
              },
            })
            return true
          }
        }
        return false
      })
      if (newlyReverted) reverted += 1
    }

    logger.info(
      { scanned: candidates.length, reverted },
      'gocardless late-failure reconcile complete',
    )
    return { scanned: candidates.length, reverted }
  },
)

export const FUNCTIONS = [gocardlessEventReceived, gocardlessReconcileLateFailures] as const
