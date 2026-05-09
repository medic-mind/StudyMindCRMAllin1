// Outbound calls TO Stripe.
// Idempotency keys per CLAUDE.md §8 + §17. Audit on every Family / Financial
// write per §20.
//
// The pattern:
//   1. Resolve the Payment we want to refund (Stripe charge id == externalId).
//   2. Persist a RefundIntent row in `pending` BEFORE the API call.
//   3. Call Stripe with a deterministic IdempotencyKey so retries do not
//      double-refund: `refund:<chargeId>:<reasonCode>` (CLAUDE.md §8).
//   4. On success: mark intent `succeeded`, write AuditLogEntry.
//   5. On failure: leave intent in `pending_review`. We do NOT auto-retry —
//      finance reviews and reissues manually. Returning the intent id lets
//      the caller surface the discrepancy.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { createClient } from './client'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface OutboundContext {
  actorId: string
  requestId: string
}

export interface RefundChargeInput {
  /** Stripe charge id, e.g. `ch_...`. Must already be mirrored as a Payment row. */
  chargeId: string
  /** Stripe `reason` value plus our own short code. Used in the idempotency key. */
  reasonCode: string
  /** Optional partial refund amount in minor units. Omit for full refund. */
  amountMinor?: number
  /** Acting CRM user — required for the audit row. */
  actorId: string
  /** OpenTelemetry trace id, also used to make the audit write idempotent. */
  requestId: string
}

export type RefundChargeStatus = 'succeeded' | 'pending_review'

export interface RefundChargeResult {
  refundIntentId: string
  status: RefundChargeStatus
  /** Populated on success. */
  stripeRefundId?: string
}

export class StripePaymentNotFoundError extends Error {
  override readonly name = 'StripePaymentNotFoundError'
  constructor(public readonly chargeId: string) {
    super(`No Payment row mirrors Stripe charge ${chargeId}`)
  }
}

/**
 * Build the deterministic Stripe idempotency key for a refund. CLAUDE.md §8:
 * `refund:<chargeId>:<reasonCode>` so that a retried Inngest step or a manual
 * re-issue with the same reason cannot double-refund.
 */
export function buildRefundIdempotencyKey(chargeId: string, reasonCode: string): string {
  return `refund:${chargeId}:${reasonCode}`
}

/**
 * Issue a refund for a Stripe charge.
 *
 * Persists a `RefundIntent` row before calling Stripe so the request is
 * recoverable across crashes. On Stripe errors we leave the intent in
 * `pending_review` — finance picks it up. We never auto-retry: the
 * idempotency key would prevent a double-charge but a real "card declined"
 * style failure may need a different path entirely.
 */
export async function refundCharge(
  db: DbClient,
  input: RefundChargeInput,
): Promise<RefundChargeResult> {
  const { chargeId, reasonCode, amountMinor, actorId, requestId } = input

  // 1. Find the local Payment row. We refuse to refund a charge we have not
  //    mirrored yet — every refund must be reconcilable against a Payment.
  const payment = await db.payment.findUnique({
    where: { externalId: chargeId },
    select: { id: true, familyId: true, amountMinor: true },
  })
  if (!payment) {
    throw new StripePaymentNotFoundError(chargeId)
  }

  const idempotencyKey = buildRefundIdempotencyKey(chargeId, reasonCode)
  const intentAmount = amountMinor ?? payment.amountMinor

  // 2. Upsert the RefundIntent in `pending`. The unique key is
  //    `idempotencyKey` so a retried call returns the same row.
  const intent = await db.refundIntent.upsert({
    where: { idempotencyKey },
    create: {
      id: createId(),
      paymentId: payment.id,
      amountMinor: intentAmount,
      reasonCode,
      status: 'pending',
      idempotencyKey,
      createdById: actorId,
      updatedById: actorId,
    },
    update: {
      // Keep existing status — replays of the same key must not regress an
      // already-succeeded intent back to `pending`.
    },
    select: { id: true, status: true, externalId: true },
  })

  // If a previous successful run already happened, return that result.
  if (intent.status === 'succeeded' && intent.externalId) {
    return {
      refundIntentId: intent.id,
      status: 'succeeded',
      stripeRefundId: intent.externalId,
    }
  }

  // 3. Call Stripe with the idempotency key.
  const stripe = createClient()
  try {
    const refund = await stripe.refunds.create(
      {
        charge: chargeId,
        ...(amountMinor !== undefined ? { amount: amountMinor } : {}),
        metadata: {
          familyId: payment.familyId,
          actorId,
          requestId,
          reasonCode,
        },
      },
      { idempotencyKey },
    )

    // 4. Mark the intent succeeded and audit the write.
    await db.refundIntent.update({
      where: { id: intent.id },
      data: {
        status: 'succeeded',
        externalId: refund.id,
        updatedById: actorId,
      },
    })

    await writeAuditLogEntry(db, {
      actorId,
      action: 'charge.refunded',
      target: { type: 'Family', id: payment.familyId },
      requestId,
      after: {
        refundIntentId: intent.id,
        stripeRefundId: refund.id,
        chargeId,
        amountMinor: intentAmount,
        reasonCode,
      },
    })

    return {
      refundIntentId: intent.id,
      status: 'succeeded',
      stripeRefundId: refund.id,
    }
  } catch (err) {
    // 5. Leave the intent in pending_review. Do not retry — finance manually
    //    inspects the failure (CLAUDE.md §8). We rethrow so callers know the
    //    Stripe call failed; the intent row remains as the durable record.
    await db.refundIntent.update({
      where: { id: intent.id },
      data: { status: 'pending_review', updatedById: actorId },
    })
    throw err
  }
}

export async function ping(_ctx: OutboundContext): Promise<void> {
  throw new Error('not implemented')
}
