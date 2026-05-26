// Per-customer payments view-models. CLAUDE.md §6.1 (Family is the billing
// unit), §6.3 (reconciliation triangle), §8 (Stripe), §9 (GoCardless), §19
// (money in integer minor units — never floats; format only at render).
//
// These are pure read shapers over the existing Payment / Invoice /
// StripeSubscription / GcMandate mirror tables. They DO NOT create any
// parallel payment tables — they join the canonical mirrors via Family /
// FinancialAccount. A Contact's payments are its Family's payments (a Contact
// without a Family has no billing relationship — the caller shows an empty
// state).

import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

/** Provider strings written by the sync layer (CLAUDE.md §8, §9). */
export type PaymentProvider = 'stripe' | 'gocardless' | 'manual' | 'unknown'

/**
 * Derived payment status. The Payment mirror has no `status` column — status
 * is derived from `reverted` / `confirmedAt` plus refund coverage:
 *   - reverted (e.g. GoCardless late failure) → `failed`
 *   - fully refunded (refunded >= amount)     → `refunded`
 *   - confirmed and not reverted              → `paid`
 *   - otherwise (received, not yet confirmed) → `pending`
 */
export type PaymentStatus = 'paid' | 'failed' | 'pending' | 'refunded'

export interface PaymentRow {
  id: string
  provider: PaymentProvider
  amountMinor: number
  currency: string
  status: PaymentStatus
  occurredAt: Date
  /** Best-effort human label — Payment has no description column; derived. */
  description: string
  /** Stripe charge / GoCardless payment id. */
  externalId: string
  /** Refunded so far against this payment, in minor units (succeeded only). */
  refundedMinor: number
  /** The Invoice this payment settled, when linked. */
  invoice: { id: string; externalId: string } | null
  /**
   * The GoCardless mandate this payment relates to (best-effort: the family's
   * mandate active around the payment time). Null for Stripe / when unknown.
   */
  relatedMandate: { id: string; gcMandateId: string; state: string } | null
  /**
   * The Stripe subscription this payment relates to (best-effort: the family's
   * subscription). Null for GoCardless / when unknown.
   */
  relatedSubscription: { id: string; stripeId: string; state: string } | null
  reverted: boolean
  revertedAt: Date | null
}

export interface PaymentSummary {
  totalPaidMinor: number
  totalRefundedMinor: number
  totalFailedMinor: number
  /** Open (invoiced but not yet covered by confirmed payments) in minor units. */
  openInvoiceMinor: number
  activeMandates: number
  activeSubscriptions: number
  lastPaymentAt: Date | null
}

function normaliseProvider(provider: string): PaymentProvider {
  if (provider === 'stripe' || provider === 'gocardless' || provider === 'manual') {
    return provider
  }
  return 'unknown'
}

function deriveStatus(args: {
  reverted: boolean
  confirmedAt: Date | null
  amountMinor: number
  refundedMinor: number
}): PaymentStatus {
  if (args.reverted) return 'failed'
  if (args.refundedMinor >= args.amountMinor && args.amountMinor > 0) return 'refunded'
  if (args.confirmedAt) return 'paid'
  return 'pending'
}

function describePayment(provider: PaymentProvider, status: PaymentStatus): string {
  const providerLabel =
    provider === 'stripe'
      ? 'Stripe card payment'
      : provider === 'gocardless'
        ? 'GoCardless Direct Debit'
        : provider === 'manual'
          ? 'Manual payment'
          : 'Payment'
  if (status === 'failed') return `${providerLabel} (reverted)`
  if (status === 'refunded') return `${providerLabel} (refunded)`
  if (status === 'pending') return `${providerLabel} (pending)`
  return providerLabel
}

interface RawPaymentRow {
  id: string
  provider: string
  amountMinor: number
  currency: string
  receivedAt: Date
  confirmedAt: Date | null
  reverted: boolean
  revertedAt: Date | null
  externalId: string
  invoice: { id: string; externalId: string } | null
  refundIntents: Array<{ amountMinor: number; status: string }>
}

/**
 * All Stripe + GoCardless payments for a Family, newest first. Each row
 * carries its derived status, refunded amount, and best-effort links to the
 * mandate / subscription it relates to.
 */
export async function paymentsForFamily(
  db: DbClient,
  familyId: string,
): Promise<PaymentRow[]> {
  const [payments, mandates, subscriptions] = await Promise.all([
    db.payment.findMany({
      where: { familyId, deletedAt: null },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        provider: true,
        amountMinor: true,
        currency: true,
        receivedAt: true,
        confirmedAt: true,
        reverted: true,
        revertedAt: true,
        externalId: true,
        invoice: { select: { id: true, externalId: true } },
        refundIntents: { select: { amountMinor: true, status: true } },
      },
    }) as Promise<RawPaymentRow[]>,
    db.gcMandate.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, gcMandateId: true, state: true },
    }),
    db.stripeSubscription.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, stripeId: true, state: true },
    }),
  ])

  // Best-effort linkage: pick the most relevant (active first, else newest)
  // mandate / subscription for the family. The mirror tables do not carry a
  // per-payment foreign key, so we relate by provider at the family level.
  const mandate =
    mandates.find((m) => m.state === 'active') ?? mandates[0] ?? null
  const subscription =
    subscriptions.find((s) => s.state === 'active') ?? subscriptions[0] ?? null

  return payments.map((p) => {
    const refundedMinor = p.refundIntents
      .filter((r) => r.status === 'succeeded')
      .reduce((sum, r) => sum + r.amountMinor, 0)
    const provider = normaliseProvider(p.provider)
    const status = deriveStatus({
      reverted: p.reverted,
      confirmedAt: p.confirmedAt,
      amountMinor: p.amountMinor,
      refundedMinor,
    })
    return {
      id: p.id,
      provider,
      amountMinor: p.amountMinor,
      currency: p.currency,
      status,
      occurredAt: p.receivedAt,
      description: describePayment(provider, status),
      externalId: p.externalId,
      refundedMinor,
      invoice: p.invoice,
      relatedMandate: provider === 'gocardless' ? mandate : null,
      relatedSubscription: provider === 'stripe' ? subscription : null,
      reverted: p.reverted,
      revertedAt: p.revertedAt,
    }
  })
}

/**
 * Aggregate payment summary for a Family. All money in minor units.
 *   - totalPaidMinor: confirmed, non-reverted payments minus refunds.
 *   - totalRefundedMinor: sum of succeeded refunds.
 *   - totalFailedMinor: reverted payments.
 *   - openInvoiceMinor: invoiced amount not covered by confirmed payments
 *     (clamped at 0 — never negative).
 */
export async function paymentSummaryForFamily(
  db: DbClient,
  familyId: string,
): Promise<PaymentSummary> {
  const rows = await paymentsForFamily(db, familyId)

  let totalPaidMinor = 0
  let totalRefundedMinor = 0
  let totalFailedMinor = 0
  let lastPaymentAt: Date | null = null

  for (const r of rows) {
    totalRefundedMinor += r.refundedMinor
    if (r.status === 'failed') {
      totalFailedMinor += r.amountMinor
    } else if (r.status === 'paid' || r.status === 'refunded') {
      totalPaidMinor += r.amountMinor - r.refundedMinor
    }
    if (r.status === 'paid' || r.status === 'refunded') {
      if (!lastPaymentAt || r.occurredAt > lastPaymentAt) {
        lastPaymentAt = r.occurredAt
      }
    }
  }

  const [invoiceAgg, activeMandates, activeSubscriptions] = await Promise.all([
    db.invoice.aggregate({
      where: { familyId, deletedAt: null },
      _sum: { amountMinor: true },
    }),
    db.gcMandate.count({ where: { familyId, deletedAt: null, state: 'active' } }),
    db.stripeSubscription.count({
      where: { familyId, deletedAt: null, state: 'active' },
    }),
  ])

  const invoicedMinor = invoiceAgg._sum.amountMinor ?? 0
  const openInvoiceMinor = Math.max(0, invoicedMinor - totalPaidMinor)

  return {
    totalPaidMinor,
    totalRefundedMinor,
    totalFailedMinor,
    openInvoiceMinor,
    activeMandates,
    activeSubscriptions,
    lastPaymentAt,
  }
}
