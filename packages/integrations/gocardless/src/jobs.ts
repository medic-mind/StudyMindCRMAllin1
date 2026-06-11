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
  syncGcPayment,
  upsertGcMandateMirror,
  upsertGcPaymentMirror,
  upsertGcPayoutMirror,
  upsertGcSubscriptionMirror,
} from '@studymind/core/finance'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { gocardlessBackfill } from './backfill'
import { createClient } from './client'
import {
  mandateMirrorInput,
  paymentMirrorInput,
  payoutMirrorInput,
  subscriptionMirrorInput,
} from './mirror-map'
import { mapMandateStatus, mapPaymentStatus } from './types'

// Event keys we currently process (resource_type/action). Anything else is
// logged and skipped (no error) so unrecognised webhook types do not blow up
// the dead-letter queue. ADR 0038 widened this to the full payment / mandate
// / subscription lifecycle so the CRM mirror is complete.
const HANDLED_KEYS = new Set<string>([
  'payments/created',
  'payments/customer_approval_granted',
  'payments/submitted',
  'payments/confirmed',
  'payments/failed',
  'payments/cancelled',
  'payments/paid_out',
  'payments/charged_back',
  'payments/late_failure_settled',
  'mandates/created',
  'mandates/customer_approval_granted',
  'mandates/submitted',
  'mandates/active',
  'mandates/failed',
  'mandates/expired',
  'mandates/cancelled',
  'mandates/replaced',
  'subscriptions/created',
  'subscriptions/customer_approval_granted',
  'subscriptions/customer_approval_denied',
  'subscriptions/payment_created',
  'subscriptions/amended',
  'subscriptions/cancelled',
  'subscriptions/finished',
  'subscriptions/paused',
  'subscriptions/resumed',
  'payouts/paid',
])

// Keys that append a timeline Interaction (kept to the meaningful moments so
// the timeline stays readable — mirror state still updates for every handled
// key). CRM-initiated subscription actions write their own Interaction in
// outbound.ts, so subscription webhook echoes are mirror-only.
const INTERACTION_KEYS = new Set<string>([
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
      links: {
        mandate?: string
        payment?: string
        new_mandate?: string
        subscription?: string
        payout?: string
      }
    }
    const occurredAt = new Date(rawEvent.created_at)

    const isPayment = type.startsWith('payments/')
    const isMandate = type.startsWith('mandates/')
    const isSubscription = type.startsWith('subscriptions/')
    const isPayout = type.startsWith('payouts/')

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
      if (isSubscription) {
        // `subscriptions/payment_created` links the subscription too; for all
        // subscription events the subscription itself is the canonical object.
        const subscriptionId = rawEvent.links.subscription
        if (subscriptionId) {
          const subscription = await client.getSubscription(subscriptionId)
          return { kind: 'subscription' as const, subscription }
        }
      }
      if (isPayout && rawEvent.links.payout) {
        const payout = await client.getPayout(rawEvent.links.payout)
        return { kind: 'payout' as const, payout }
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
    // The complete provider mirror (ADR 0038) updates for every handled event,
    // regardless of whether the customer is linked to a CRM Family yet; the
    // reconciliation-facing tables (`Payment`) still require the Family link.
    const persisted = await step.run('persist', async () => {
      if (refetched.kind === 'payment') {
        const p = refetched.payment
        const mandateId = p.links.mandate ?? null
        const mappedStatus = mapPaymentStatus(p.status)

        // Resolve customer + contact through the mandate mirror.
        const mandateRow = mandateId
          ? await db.gcMandate.findUnique({
              where: { gcMandateId: mandateId },
              select: { gcCustomerId: true },
            })
          : null
        const customerRow = mandateRow?.gcCustomerId
          ? await db.gcCustomer.findUnique({
              where: { gcCustomerId: mandateRow.gcCustomerId },
              select: { contactId: true },
            })
          : null

        await upsertGcPaymentMirror(
          db,
          paymentMirrorInput(p, { gcCustomerId: mandateRow?.gcCustomerId ?? null }),
        )

        if (!mandateId) {
          return {
            kind: 'payment' as const,
            unresolved: true,
            familyId: null as string | null,
            contactId: null as string | null,
            gcId: p.id,
            status: mappedStatus,
            reversal: null as { reopenedAllocations: number } | null,
          }
        }
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
          contactId: customerRow?.contactId ?? null,
          gcId: p.id,
          status: mappedStatus,
          reversal,
        }
      }

      if (refetched.kind === 'payout') {
        // Payouts are merchant-side money movement — mirror only, no Family
        // link and no timeline Interaction.
        await upsertGcPayoutMirror(db, payoutMirrorInput(refetched.payout))
        return {
          kind: 'payout' as const,
          unresolved: true,
          familyId: null as string | null,
          contactId: null as string | null,
          gcId: refetched.payout.id,
          status: refetched.payout.status,
        }
      }

      if (refetched.kind === 'subscription') {
        const s = refetched.subscription
        const mandateRow = s.links.mandate
          ? await db.gcMandate.findUnique({
              where: { gcMandateId: s.links.mandate },
              select: { gcCustomerId: true, familyId: true },
            })
          : null
        await upsertGcSubscriptionMirror(
          db,
          subscriptionMirrorInput(s, { gcCustomerId: mandateRow?.gcCustomerId ?? null }),
        )
        return {
          kind: 'subscription' as const,
          unresolved: mandateRow?.familyId == null,
          familyId: mandateRow?.familyId ?? null,
          contactId: null as string | null,
          gcId: s.id,
          status: s.status,
        }
      }

      // mandate
      const m = refetched.mandate
      const mappedStatus = mapMandateStatus(m.status)
      const familyId = await resolveFamilyByGcMandate(db, m.id)

      // Family can also arrive through the customer link (ADR 0038).
      const customer = m.links.customer
        ? await db.gcCustomer.findUnique({
            where: { gcCustomerId: m.links.customer },
            select: { contactId: true, familyId: true },
          })
        : null

      const sync = await upsertGcMandateMirror(
        db,
        mandateMirrorInput(m, { familyId: familyId ?? customer?.familyId ?? null }),
      )

      // Replacement — CLAUDE.md §9. The mirror keeps the chain even when no
      // Family is linked yet.
      let replacement: { newGcMandateId: string } | null = null
      if (rawEvent.action === 'replaced' && refetched.newMandate) {
        const newM = refetched.newMandate
        await upsertGcMandateMirror(
          db,
          mandateMirrorInput(newM, { familyId: sync.familyId ?? null }),
        )
        await linkReplacedMandate(db, m.id, newM.id)
        replacement = { newGcMandateId: newM.id }
      }

      return {
        kind: 'mandate' as const,
        unresolved: sync.familyId === null,
        familyId: sync.familyId,
        contactId: customer?.contactId ?? null,
        gcId: m.id,
        status: mappedStatus,
        replacement,
      }
    })

    if (persisted.unresolved || !persisted.familyId) {
      logger.info(
        { eventId, type, gcId: persisted.gcId },
        'gocardless event mirrored without a Family link — visible in the DD workspace',
      )
      await step.run('mark-unresolved', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { ok: true, mirrored: true, linked: false }
    }

    const familyId = persisted.familyId

    // 4. Append a timeline Interaction for the meaningful moments only —
    // idempotent on (familyId, eventId).
    if (INTERACTION_KEYS.has(type)) {
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
            contactId: persisted.contactId,
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
    }

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
    | { kind: 'mandate'; replacement: { newGcMandateId: string } | null }
    | { kind: 'subscription' }
    | { kind: 'payout' },
): string {
  if (persisted.kind === 'subscription' || persisted.kind === 'payout') {
    return `GoCardless ${type}`
  }
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

export const FUNCTIONS = [
  gocardlessEventReceived,
  gocardlessReconcileLateFailures,
  gocardlessBackfill,
] as const
