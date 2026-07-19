// Direct Debit defaulters (Slice B). CLAUDE.md §6.3 (reconciliation triangle),
// §9 (GoCardless — late failures revert confirmed payments, mandates can fail/
// cancel/expire), §19 (money in integer minor units), §3 (read-only analysis;
// never auto-charge or auto-dun — this module surfaces, humans act).
//
// "Defaulted" is defined precisely below. All signals are derived from the
// existing GcMandate / Payment / Invoice mirrors — we add no parallel tables.
//
// A Family is a DD defaulter if ANY of:
//   1. A GoCardless mandate in failed / cancelled / expired AND the family has
//      an outstanding balance (invoiced minus paid > 0).
//   2. A confirmed GoCardless payment later reverted (late_failure_settled)
//      and not re-collected — i.e. a reverted payment with no subsequent
//      confirmed payment of at least the same amount.
//   3. Two or more reverted GoCardless Direct Debits in the trailing 90 days
//      (consecutive-failure proxy; CLAUDE.md §6.4).
//
// (The spec also mentions an "instalment schedule with an errored payment".
// GoCardless instalment-schedule failures surface in our mirror as reverted /
// failed `Payment` rows — condition 2/3 cover them. We do not model a separate
// instalment-schedule entity; doing so would be a parallel table for no new
// signal.)

import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000
const CONSECUTIVE_FAILURE_THRESHOLD = 2

export type DefaulterReason =
  | 'mandate_inactive_with_balance'
  | 'reverted_payment_not_recollected'
  | 'multiple_failed_direct_debits_90d'

export interface DefaulterRow {
  familyId: string
  billingContactName: string | null
  /** Worst (most-inactive) mandate state observed for the family. */
  mandateStatus: string | null
  /** Reverted GoCardless Direct Debits in the trailing 90 days. */
  failedCount: number
  lastFailureAt: Date | null
  totalPaidMinor: number
  /** Contracted/invoiced total in minor units. */
  totalOwedMinor: number
  /** Outstanding = owed minus paid, clamped at 0. */
  outstandingMinor: number
  /** Representative date of the issue for the go-live cutoff (ADR 0045): the
   *  last DD failure, else the family's latest GoCardless payment activity. */
  issueDate: Date | null
  reasons: DefaulterReason[]
}

export interface ListDefaultersOptions {
  /** Reference time, injected for determinism in tests. Defaults to now. */
  now?: Date
}

interface FamilyPaymentFacts {
  familyId: string
  billingContactName: string | null
  invoicedMinor: number
  /** Confirmed, non-reverted GoCardless + Stripe payments net of nothing here. */
  paidMinor: number
  /** Reverted GoCardless payments (all time). */
  revertedPayments: Array<{ amountMinor: number; revertedAt: Date | null; receivedAt: Date }>
  /** Confirmed, non-reverted GoCardless payments (for re-collection check). */
  confirmedGcPayments: Array<{ amountMinor: number; receivedAt: Date }>
  /** Worst inactive mandate state, or null when all mandates are healthy. */
  inactiveMandateState: string | null
  /** Latest GoCardless payment activity date (confirmed or reverted) — the
   *  cutoff fallback when there's no reverted-payment failure date. */
  latestActivityAt?: Date | null
}

function contactName(c: {
  firstName: string | null
  lastName: string | null
} | null): string | null {
  if (!c) return null
  const name = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  return name || null
}

/**
 * Pure classifier. Given a family's payment facts and a reference time,
 * returns the defaulter row if the family qualifies, else null.
 */
export function classifyDefaulter(
  facts: FamilyPaymentFacts,
  now: Date,
): DefaulterRow | null {
  const reasons: DefaulterReason[] = []

  const outstandingMinor = Math.max(0, facts.invoicedMinor - facts.paidMinor)

  // Condition 1 — inactive mandate AND outstanding balance.
  if (facts.inactiveMandateState && outstandingMinor > 0) {
    reasons.push('mandate_inactive_with_balance')
  }

  // Condition 2 — a reverted payment not re-collected. We treat the family as
  // "not re-collected" when the total confirmed GoCardless payments do not
  // cover the total reverted amount.
  const totalRevertedMinor = facts.revertedPayments.reduce((s, p) => s + p.amountMinor, 0)
  const totalConfirmedGcMinor = facts.confirmedGcPayments.reduce(
    (s, p) => s + p.amountMinor,
    0,
  )
  if (totalRevertedMinor > 0 && totalConfirmedGcMinor < totalRevertedMinor) {
    reasons.push('reverted_payment_not_recollected')
  }

  // Condition 3 — >= 2 reverted Direct Debits in the trailing 90 days.
  const windowStart = new Date(now.getTime() - NINETY_DAYS_MS)
  const recentFailures = facts.revertedPayments.filter((p) => {
    const at = p.revertedAt ?? p.receivedAt
    return at >= windowStart
  })
  if (recentFailures.length >= CONSECUTIVE_FAILURE_THRESHOLD) {
    reasons.push('multiple_failed_direct_debits_90d')
  }

  if (reasons.length === 0) return null

  const lastFailureAt = facts.revertedPayments.reduce<Date | null>((latest, p) => {
    const at = p.revertedAt ?? p.receivedAt
    if (!latest || at > latest) return at
    return latest
  }, null)

  return {
    familyId: facts.familyId,
    billingContactName: facts.billingContactName,
    mandateStatus: facts.inactiveMandateState,
    failedCount: facts.revertedPayments.length,
    lastFailureAt,
    totalPaidMinor: facts.paidMinor,
    totalOwedMinor: facts.invoicedMinor,
    outstandingMinor,
    issueDate: lastFailureAt ?? facts.latestActivityAt ?? null,
    reasons,
  }
}

/**
 * Hydrate per-family payment facts. Walks GoCardless mandates, the invoice
 * total, confirmed payments, and reverted payments for one family.
 */
async function loadFamilyFacts(
  db: DbClient,
  familyId: string,
): Promise<FamilyPaymentFacts> {
  const [family, mandates, invoiceAgg, payments] = await Promise.all([
    db.family.findUnique({
      where: { id: familyId },
      select: {
        id: true,
        billingContact: { select: { firstName: true, lastName: true } },
      },
    }),
    db.gcMandate.findMany({
      where: { familyId, deletedAt: null },
      select: { state: true },
    }),
    db.invoice.aggregate({
      where: { familyId, deletedAt: null },
      _sum: { amountMinor: true },
    }),
    db.payment.findMany({
      where: { familyId, deletedAt: null },
      select: {
        provider: true,
        amountMinor: true,
        reverted: true,
        revertedAt: true,
        receivedAt: true,
        confirmedAt: true,
      },
    }),
  ])

  // Confirmed, non-reverted payments count toward "paid" (Stripe + GoCardless).
  const paidMinor = payments
    .filter((p) => !p.reverted && p.confirmedAt)
    .reduce((s, p) => s + p.amountMinor, 0)

  const revertedPayments = payments
    .filter((p) => p.provider === 'gocardless' && p.reverted)
    .map((p) => ({
      amountMinor: p.amountMinor,
      revertedAt: p.revertedAt,
      receivedAt: p.receivedAt,
    }))

  const confirmedGcPayments = payments
    .filter((p) => p.provider === 'gocardless' && !p.reverted && p.confirmedAt)
    .map((p) => ({ amountMinor: p.amountMinor, receivedAt: p.receivedAt }))

  // Latest GoCardless payment activity (confirmed receipt or reversal) — the
  // cutoff fallback for issues (e.g. mandate-inactive-with-balance) that carry
  // no reverted-payment failure date.
  let latestActivityAt: Date | null = null
  for (const p of payments) {
    if (p.provider !== 'gocardless') continue
    for (const at of [p.receivedAt, p.confirmedAt, p.revertedAt]) {
      if (at && (!latestActivityAt || at > latestActivityAt)) latestActivityAt = at
    }
  }

  // Worst inactive mandate state (prefer failed > cancelled > expired ordering
  // is not meaningful; we just report one inactive state if any exists).
  const inactiveMandate =
    mandates.find((m) => m.state === 'failed') ??
    mandates.find((m) => m.state === 'cancelled') ??
    mandates.find((m) => m.state === 'expired') ??
    null

  return {
    familyId,
    billingContactName: contactName(family?.billingContact ?? null),
    invoicedMinor: invoiceAgg._sum.amountMinor ?? 0,
    paidMinor,
    revertedPayments,
    confirmedGcPayments,
    inactiveMandateState: inactiveMandate?.state ?? null,
    latestActivityAt,
  }
}

/**
 * List all Direct Debit defaulter families, sorted by outstandingMinor desc.
 *
 * Candidate families are those with at least one GoCardless mandate or
 * GoCardless payment — we never scan card-only families. The final defaulter
 * decision is made by `classifyDefaulter`.
 */
export async function listDefaulters(
  db: DbClient,
  opts: ListDefaultersOptions = {},
): Promise<DefaulterRow[]> {
  const now = opts.now ?? new Date()

  // Candidate families: those touched by GoCardless at all. Mandates without
  // a Family link (complete-mirror import, ADR 0038) are excluded — there is
  // no Family to dun.
  const [mandateFamilies, paymentFamilies] = await Promise.all([
    db.gcMandate.findMany({
      where: { deletedAt: null, familyId: { not: null } },
      select: { familyId: true },
      distinct: ['familyId'],
    }),
    db.payment.findMany({
      where: { deletedAt: null, provider: 'gocardless' },
      select: { familyId: true },
      distinct: ['familyId'],
    }),
  ])

  const familyIds = Array.from(
    new Set([
      ...mandateFamilies.map((m) => m.familyId).filter((id): id is string => id !== null),
      ...paymentFamilies.map((p) => p.familyId),
    ]),
  )

  const rows: DefaulterRow[] = []
  for (const familyId of familyIds) {
    const facts = await loadFamilyFacts(db, familyId)
    const row = classifyDefaulter(facts, now)
    if (row) rows.push(row)
  }

  rows.sort((a, b) => b.outstandingMinor - a.outstandingMinor)
  return rows
}

export interface DefaulterDetail {
  familyId: string
  billingContactName: string | null
  mandates: Array<{ id: string; gcMandateId: string; state: string; createdAt: Date }>
  payments: Array<{
    id: string
    amountMinor: number
    currency: string
    receivedAt: Date
    confirmedAt: Date | null
    reverted: boolean
    revertedAt: Date | null
    externalId: string
    invoiceExternalId: string | null
  }>
  totalPaidMinor: number
  totalOwedMinor: number
  outstandingMinor: number
}

/**
 * Full mandate + payment history for one family's defaulter drill-down.
 * Read-only — no mutation, no charge.
 */
export async function defaulterDetail(
  db: DbClient,
  familyId: string,
): Promise<DefaulterDetail | null> {
  const family = await db.family.findUnique({
    where: { id: familyId },
    select: {
      id: true,
      billingContact: { select: { firstName: true, lastName: true } },
    },
  })
  if (!family) return null

  const [mandates, payments, invoiceAgg] = await Promise.all([
    db.gcMandate.findMany({
      where: { familyId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { id: true, gcMandateId: true, state: true, createdAt: true },
    }),
    db.payment.findMany({
      where: { familyId, deletedAt: null },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        amountMinor: true,
        currency: true,
        receivedAt: true,
        confirmedAt: true,
        reverted: true,
        revertedAt: true,
        externalId: true,
        invoice: { select: { externalId: true } },
      },
    }),
    db.invoice.aggregate({
      where: { familyId, deletedAt: null },
      _sum: { amountMinor: true },
    }),
  ])

  const totalPaidMinor = payments
    .filter((p) => !p.reverted && p.confirmedAt)
    .reduce((s, p) => s + p.amountMinor, 0)
  const totalOwedMinor = invoiceAgg._sum.amountMinor ?? 0

  return {
    familyId: family.id,
    billingContactName: contactName(family.billingContact),
    mandates,
    payments: payments.map((p) => ({
      id: p.id,
      amountMinor: p.amountMinor,
      currency: p.currency,
      receivedAt: p.receivedAt,
      confirmedAt: p.confirmedAt,
      reverted: p.reverted,
      revertedAt: p.revertedAt,
      externalId: p.externalId,
      invoiceExternalId: p.invoice?.externalId ?? null,
    })),
    totalPaidMinor,
    totalOwedMinor,
    outstandingMinor: Math.max(0, totalOwedMinor - totalPaidMinor),
  }
}
