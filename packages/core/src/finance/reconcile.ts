// Reconciliation engine — the triangle from CLAUDE.md §6.3.
//
// Given a Family, this module computes a list of *proposed* discrepancies.
// It never persists; the caller (Inngest job, ad-hoc CLI, finance UI) decides
// what to do. Discrepancies are never auto-resolved (CLAUDE.md §3, §35).
//
// Three legs:
//   1. Hours leg     — sum delivered hours from BookingSession.
//   2. Money leg     — sum confirmed Payment - refunded.
//   3. Allocation leg — sum(Allocation.amount) ≤ Payment.amount per payment
//                       (invariant from §41.2). FIFO allocation per §9.

import { createHash } from 'node:crypto'

import type { Prisma, PrismaClient } from '@prisma/client'

import {
  countDeliveredHours,
  type BookingSessionRecord,
  type BookingSessionState,
} from './booking-rules'

type DbClient = PrismaClient | Prisma.TransactionClient

export type ReconciliationCategoryValue =
  | 'hours_mismatch'
  | 'payment_unallocated'
  | 'late_failure_pending_action'
  | 'churned_with_active_subscription'

export interface ReconciliationDiscrepancyInput {
  familyId: string
  category: ReconciliationCategoryValue
  summary: string
  payload: Record<string, unknown>
  /**
   * Stable hash of the inputs that produced this discrepancy. The nightly
   * reconcile is keyed on (familyId, category, contextHash), so re-running
   * the engine without state changes does not create duplicate rows.
   */
  contextHash: string
}

export interface ReconcileResult {
  discrepancies: ReconciliationDiscrepancyInput[]
}

function hashContext(parts: readonly (string | number | boolean | null)[]): string {
  const h = createHash('sha256')
  h.update(parts.map((p) => String(p)).join('|'))
  return h.digest('hex').slice(0, 32)
}

interface PaymentRow {
  id: string
  amountMinor: number
  reverted: boolean
  confirmedAt: Date | null
  receivedAt: Date
}

interface AllocationRow {
  id: string
  paymentId: string
  amountMinor: number
}

interface SubscriptionRow {
  id: string
  state: string
}

interface FamilyRow {
  id: string
  state: string
  financialAccount: { status: string } | null
}

/**
 * Run the reconciliation engine for a single Family. Returns proposed
 * discrepancies — the caller persists with idempotent upsert keyed on the
 * unique (familyId, category, contextHash) index.
 */
export async function reconcileFamily(
  db: DbClient,
  familyId: string,
): Promise<ReconcileResult> {
  const family = (await db.family.findUnique({
    where: { id: familyId },
    select: {
      id: true,
      state: true,
      financialAccount: { select: { status: true } },
    },
  })) as FamilyRow | null

  if (!family) {
    return { discrepancies: [] }
  }

  const discrepancies: ReconciliationDiscrepancyInput[] = []

  // ---------------------------------------------------------------------------
  // Leg 1 — hours.
  // ---------------------------------------------------------------------------
  const sessions = (await db.bookingSession.findMany({
    where: { booking: { familyId, deletedAt: null }, deletedAt: null },
    select: {
      id: true,
      state: true,
      deliveredHours: true,
      contractedHours: true,
      correctedById: true,
    },
  })) as Array<{
    id: string
    state: BookingSessionState
    deliveredHours: number
    contractedHours: number
    correctedById: string | null
  }>

  const sessionRecords: BookingSessionRecord[] = sessions.map((s) => ({
    id: s.id,
    state: s.state,
    deliveredHours: s.deliveredHours,
    correctedSessionId: s.correctedById,
  }))

  const deliveredHours = countDeliveredHours(sessionRecords)
  const contractedHours = sessions.reduce((acc, s) => acc + (s.contractedHours ?? 0), 0)

  // We surface a hours_mismatch discrepancy when delivered exceeds contracted —
  // this is the case finance always wants to look at.
  if (contractedHours > 0 && deliveredHours > contractedHours) {
    discrepancies.push({
      familyId,
      category: 'hours_mismatch',
      summary: `Delivered hours (${deliveredHours}) exceed contracted (${contractedHours})`,
      payload: { deliveredHours, contractedHours },
      contextHash: hashContext(['hours', deliveredHours, contractedHours]),
    })
  }

  // ---------------------------------------------------------------------------
  // Leg 2 — money: confirmed (non-reverted) Payments and their allocations.
  // ---------------------------------------------------------------------------
  const payments = (await db.payment.findMany({
    where: { familyId, deletedAt: null },
    select: {
      id: true,
      amountMinor: true,
      reverted: true,
      confirmedAt: true,
      receivedAt: true,
    },
    orderBy: { receivedAt: 'asc' }, // FIFO per §9
  })) as PaymentRow[]

  const allocations = (await db.allocation.findMany({
    // Only ACTIVE allocations. Re-allocation soft-deletes the superseded rows
    // (finance router `allocation.upsert`), so without this filter a payment's
    // deleted + active rows sum together and can exceed the payment amount —
    // tripping the §41.2 invariant below and wedging the nightly pipeline.
    where: { payment: { familyId }, deletedAt: null },
    select: { id: true, paymentId: true, amountMinor: true },
  })) as AllocationRow[]

  const allocByPayment = new Map<string, number>()
  for (const a of allocations) {
    allocByPayment.set(a.paymentId, (allocByPayment.get(a.paymentId) ?? 0) + a.amountMinor)
  }

  for (const p of payments) {
    const allocated = allocByPayment.get(p.id) ?? 0

    // Hard invariant: allocations cannot exceed the payment. §41.2.
    if (allocated > p.amountMinor) {
      throw new Error(
        `Allocation invariant violated: payment ${p.id} amount ${p.amountMinor} < allocated ${allocated}`,
      )
    }

    // Confirmed payment with leftover unallocated cents — surface as a
    // discrepancy so finance can FIFO it against the next open booking.
    if (!p.reverted && p.confirmedAt && allocated < p.amountMinor) {
      const unallocated = p.amountMinor - allocated
      discrepancies.push({
        familyId,
        category: 'payment_unallocated',
        summary: `Payment ${p.id} has ${unallocated} minor units unallocated`,
        payload: {
          paymentId: p.id,
          amountMinor: p.amountMinor,
          allocatedMinor: allocated,
          unallocatedMinor: unallocated,
        },
        contextHash: hashContext(['payment_unallocated', p.id, p.amountMinor, allocated]),
      })
    }
  }

  // ---------------------------------------------------------------------------
  // Leg 3 — late-failure pending action surfaced from FinancialAccount status.
  // CLAUDE.md §9.
  // ---------------------------------------------------------------------------
  if (family.financialAccount?.status === 'reverted_payment_pending_action') {
    discrepancies.push({
      familyId,
      category: 'late_failure_pending_action',
      summary: 'GoCardless late-failure reversal pending finance action',
      payload: { financialAccountStatus: family.financialAccount.status },
      contextHash: hashContext(['late_failure_pending_action', familyId]),
    })
  }

  // ---------------------------------------------------------------------------
  // Leg 4 — churned + active subscription. §41.2.
  // ---------------------------------------------------------------------------
  if (family.state === 'churned') {
    const activeSubs = (await db.stripeSubscription.findMany({
      where: { familyId, deletedAt: null, state: 'active' },
      select: { id: true, state: true },
    })) as SubscriptionRow[]

    if (activeSubs.length > 0) {
      discrepancies.push({
        familyId,
        category: 'churned_with_active_subscription',
        summary: `Family is churned but has ${activeSubs.length} active subscription(s)`,
        payload: { subscriptionIds: activeSubs.map((s) => s.id) },
        contextHash: hashContext([
          'churned_with_active_subscription',
          familyId,
          activeSubs.map((s) => s.id).sort().join(','),
        ]),
      })
    }
  }

  return { discrepancies }
}
