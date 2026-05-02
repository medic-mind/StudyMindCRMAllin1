// Inngest functions triggered after a Stripe webhook lands.
// CLAUDE.md §7.1 (handler stays thin), §8 (refetch — webhook payloads are
// notifications, not state), §17 (concurrency, granular step.run, idempotency).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  resolveFamilyByStripeCustomer,
  syncStripeInvoice,
  syncStripeSubscription,
} from '@studymind/core/finance'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient } from './client'
import { mapSubscriptionState } from './types'

// Event types we currently process. Anything else is logged and skipped (no
// error) so unrecognised webhook types do not blow up the dead-letter queue.
const HANDLED_TYPES = new Set<string>([
  'invoice.payment_failed',
  'customer.subscription.updated',
])

interface StripeEventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

export const stripeEventReceived = inngest.createFunction(
  {
    id: 'stripe/event.received',
    name: 'Process Stripe webhook event',
    concurrency: { limit: 10 },
    retries: 6,
  },
  { event: 'stripe/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as StripeEventReceivedData
    const { eventId, type } = data

    if (!HANDLED_TYPES.has(type)) {
      logger.info({ eventId, type }, 'stripe event type not handled — skipping')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: data.providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'type_not_handled' }
    }

    // 1. Refetch the canonical object from Stripe. Webhook payloads are
    //    notifications; we never trust them for state. CLAUDE.md §8.
    const refetched = await step.run('refetch', async () => {
      const stripe = createClient()
      const fresh = await stripe.events.retrieve(eventId)
      return fresh
    })

    // 2. Persist into our normalised mirror tables. The mapper is keyed on
    //    Stripe object ids so retries are safe.
    const persisted = await step.run('persist', async () => {
      if (refetched.type === 'customer.subscription.updated') {
        const sub = refetched.data.object as {
          id: string
          customer: string | { id: string }
          status: string
          current_period_end: number | null
        }
        const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id
        const result = await syncStripeSubscription(db, {
          stripeId: sub.id,
          stripeCustomerId: customerId,
          state: mapSubscriptionState(sub.status),
          currentPeriodEnd: sub.current_period_end
            ? new Date(sub.current_period_end * 1000)
            : null,
        })
        return {
          kind: 'subscription' as const,
          stripeId: sub.id,
          stripeCustomerId: customerId,
          ...result,
        }
      }

      // invoice.payment_failed
      const inv = refetched.data.object as {
        id: string
        customer: string | { id: string }
        amount_due: number
        currency: string
        created: number
        due_date: number | null
      }
      const customerId = typeof inv.customer === 'string' ? inv.customer : inv.customer.id
      const result = await syncStripeInvoice(db, {
        stripeInvoiceId: inv.id,
        stripeCustomerId: customerId,
        amountDueMinor: inv.amount_due,
        currency: inv.currency.toUpperCase(),
        issuedAt: new Date(inv.created * 1000),
        dueAt: inv.due_date ? new Date(inv.due_date * 1000) : null,
      })
      return {
        kind: 'invoice' as const,
        stripeId: inv.id,
        stripeCustomerId: customerId,
        ...result,
      }
    })

    if (persisted.unresolved) {
      // No Family connected to this Stripe customer. Surface and stop —
      // CLAUDE.md §3 forbids silent drops. Finance picks this up manually.
      logger.warn(
        { eventId, type, stripeCustomerId: persisted.stripeCustomerId },
        'no Family linked to Stripe customer — skipping persist',
      )
      await step.run('mark-unresolved', async () => {
        await db.providerEvent.update({
          where: { id: data.providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'unresolved_customer' }
    }

    // 3. Append a timeline Interaction on the resolved Family. Idempotent
    //    by checking for an existing interaction tagged with this eventId.
    await step.run('interaction', async () => {
      const familyId = await resolveFamilyByStripeCustomer(db, persisted.stripeCustomerId)
      if (!familyId) return

      const existing = await db.interaction.findFirst({
        where: {
          familyId,
          type: 'payment',
          payload: { path: ['stripeEventId'], equals: eventId },
        },
        select: { id: true },
      })
      if (existing) return

      await db.interaction.create({
        data: {
          id: createId(),
          type: 'payment',
          familyId,
          occurredAt: new Date(),
          summary:
            persisted.kind === 'subscription'
              ? `Stripe subscription updated (${type})`
              : `Stripe invoice payment failed`,
          payload: {
            stripeEventId: eventId,
            stripeEventType: type,
            stripeObjectId: persisted.stripeId,
            kind: persisted.kind,
          },
        },
      })
    })

    // 4. Audit. Idempotent via the requestId == eventId trick.
    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: `stripe.${type}`,
        target: { type: 'Family', id: persisted.familyId ?? 'unknown' },
        requestId: eventId,
        after: {
          stripeEventId: eventId,
          stripeObjectId: persisted.stripeId,
          kind: persisted.kind,
        },
      })
    })

    // 5. Mark the ProviderEvent row processed.
    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: data.providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, kind: persisted.kind }
  },
)

export const FUNCTIONS = [stripeEventReceived] as const
