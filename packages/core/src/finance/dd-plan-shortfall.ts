// Direct Debit plan shortfalls (ADR 0038, CLAUDE.md §6.3 reconciliation
// triangle, §19 integer minor units, §3 read-only — surfaces, never charges).
//
// The defaulter engine (`dd-defaulters.ts`) is invoice- and failed-payment-
// driven: it answers "who has an inactive mandate or bounced a Direct Debit
// and still owes money". It is deliberately blind to a family that quietly
// *cancelled a fixed-length plan part-way through* without ever failing a
// payment — there is no reverted payment and no unpaid invoice, so nothing
// fires. Yet the family contracted to pay `count × amount` and stopped early.
//
// This module closes that gap. For every GoCardless plan (subscription) that
// has ended — `cancelled` or `finished` — with a known total payment count, we
// compare what was contracted against what was actually collected and surface
// the shortfall. It reads only the existing GoCardless mirror (GcSubscription
// + GcPayment), adds no parallel tables, and never mutates anything.
//
// "Total amount due" is the contracted plan value: `totalPaymentCount ×
// amountMinor`. Open-ended plans (no count) have no contracted total, so there
// is nothing to reconcile against — they are excluded (we fail closed, §8,
// rather than invent a total).

import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

/** GoCardless payment states that count as money actually collected. */
const COLLECTED_PAYMENT_STATES = new Set(['confirmed', 'paid_out'])

/** Terminal subscription states — a plan that has stopped collecting. */
const TERMINAL_PLAN_STATES = ['cancelled', 'finished'] as const

export type PlanShortfallReason =
  /** Plan cancelled before its full number of instalments was collected. */
  | 'cancelled_partway'
  /** Money was left uncollected against the contracted plan total. */
  | 'collection_shortfall'
  /** Plan reported `finished` yet collected fewer instalments than contracted. */
  | 'finished_underpaid'

export interface PlanFacts {
  gcSubscriptionId: string
  name: string | null
  status: string
  amountMinor: number
  currency: string
  /** GoCardless `count` — total contracted instalments, or null if open-ended. */
  totalPaymentCount: number | null
  gcCustomerId: string | null
  startDate: Date | null
  endDate: Date | null
  gcCreatedAt: Date | null
  /** Confirmed/paid-out payments collected against this plan. */
  collectedCount: number
  collectedMinor: number
  /** Most recent collected payment's charge date, for display. */
  lastCollectedAt: Date | null
}

export interface PlanShortfall {
  gcSubscriptionId: string
  name: string | null
  status: string
  currency: string
  amountMinor: number
  /** Contracted instalment count. */
  totalPaymentCount: number
  /** Instalments actually collected. */
  collectedCount: number
  /** Contracted plan value = totalPaymentCount × amountMinor. */
  expectedTotalMinor: number
  /** Money actually collected (confirmed + paid out). */
  collectedMinor: number
  /** Amount still due against the contracted total, clamped at 0. */
  shortfallMinor: number
  /** Instalments contracted but never collected, clamped at 0. */
  missedCount: number
  /** True when the plan was cancelled before completing its instalments. */
  cancelledPartway: boolean
  endDate: Date | null
  lastCollectedAt: Date | null
  /** Representative date for the go-live cutoff (ADR 0045): when the plan ended,
   *  else its last collection. */
  issueDate: Date | null
  gcCustomerId: string | null
  reasons: PlanShortfallReason[]
}

/**
 * Pure classifier. Given one ended plan's facts, return its shortfall row, or
 * null when the plan completed cleanly (or has no contracted total to measure
 * against). No I/O, integer minor units only.
 */
export function classifyPlanShortfall(facts: PlanFacts): PlanShortfall | null {
  const isTerminal =
    facts.status === 'cancelled' || facts.status === 'finished'
  if (!isTerminal) return null

  // No contracted total → nothing to reconcile against (fail closed, §8).
  if (facts.totalPaymentCount == null || facts.totalPaymentCount <= 0) return null

  const expectedTotalMinor = facts.totalPaymentCount * facts.amountMinor
  const collectedMinor = facts.collectedMinor
  const shortfallMinor = Math.max(0, expectedTotalMinor - collectedMinor)
  const missedCount = Math.max(0, facts.totalPaymentCount - facts.collectedCount)
  const endedEarly = facts.collectedCount < facts.totalPaymentCount

  // Completed in full (every instalment collected, no money left) — healthy.
  if (!endedEarly && shortfallMinor === 0) return null

  const reasons: PlanShortfallReason[] = []
  if (facts.status === 'cancelled' && endedEarly) reasons.push('cancelled_partway')
  if (facts.status === 'finished' && endedEarly) reasons.push('finished_underpaid')
  if (shortfallMinor > 0) reasons.push('collection_shortfall')
  if (reasons.length === 0) return null

  return {
    gcSubscriptionId: facts.gcSubscriptionId,
    name: facts.name,
    status: facts.status,
    currency: facts.currency,
    amountMinor: facts.amountMinor,
    totalPaymentCount: facts.totalPaymentCount,
    collectedCount: facts.collectedCount,
    expectedTotalMinor,
    collectedMinor,
    shortfallMinor,
    missedCount,
    cancelledPartway: facts.status === 'cancelled' && endedEarly,
    endDate: facts.endDate,
    lastCollectedAt: facts.lastCollectedAt,
    issueDate: facts.endDate ?? facts.lastCollectedAt,
    gcCustomerId: facts.gcCustomerId,
    reasons,
  }
}

/** Roll a plan's payments up into collected count / amount / last date. */
function collectedFromPayments(
  payments: Array<{ status: string; amountMinor: number; chargeDate: Date | null }>,
): Pick<PlanFacts, 'collectedCount' | 'collectedMinor' | 'lastCollectedAt'> {
  let collectedCount = 0
  let collectedMinor = 0
  let lastCollectedAt: Date | null = null
  for (const p of payments) {
    if (!COLLECTED_PAYMENT_STATES.has(p.status)) continue
    collectedCount += 1
    collectedMinor += p.amountMinor
    if (p.chargeDate && (!lastCollectedAt || p.chargeDate > lastCollectedAt)) {
      lastCollectedAt = p.chargeDate
    }
  }
  return { collectedCount, collectedMinor, lastCollectedAt }
}

export interface PlanShortfallWithCustomer extends PlanShortfall {
  customerName: string | null
  contactId: string | null
  familyId: string | null
}

/**
 * List every ended GoCardless plan that collected less than it contracted —
 * the "cancelled part-way" / underpaid plans — sorted by shortfall desc.
 *
 * Read-only. Joins the customer (and its CRM contact/family link) for display
 * so finance can jump straight to the family. Soft links are JS-joined on
 * `gcCustomerId` (ADR 0038), never DB FKs.
 */
export async function listPlanShortfalls(
  db: DbClient,
): Promise<PlanShortfallWithCustomer[]> {
  const subscriptions = await db.gcSubscription.findMany({
    // `shortfallIgnored` plans are historic (cancelled before go-live, June
    // 2026) and handled on another system — excluded so the CRM only tracks
    // cancellations from go-live onward (ADR 0038, seventh amendment).
    where: { deletedAt: null, status: { in: [...TERMINAL_PLAN_STATES] }, shortfallIgnored: false },
    select: {
      gcSubscriptionId: true,
      name: true,
      status: true,
      amountMinor: true,
      currency: true,
      totalPaymentCount: true,
      gcCustomerId: true,
      startDate: true,
      endDate: true,
      gcCreatedAt: true,
    },
  })

  // Only fixed-length plans can have a shortfall — drop open-ended ones early
  // so we never load payments we will not use.
  const fixedLength = subscriptions.filter(
    (s) => s.totalPaymentCount != null && s.totalPaymentCount > 0,
  )
  if (fixedLength.length === 0) return []

  const subscriptionIds = fixedLength.map((s) => s.gcSubscriptionId)
  const payments = await db.gcPayment.findMany({
    where: { gcSubscriptionId: { in: subscriptionIds }, deletedAt: null },
    select: { gcSubscriptionId: true, status: true, amountMinor: true, chargeDate: true },
  })

  const paymentsBySub = new Map<
    string,
    Array<{ status: string; amountMinor: number; chargeDate: Date | null }>
  >()
  for (const p of payments) {
    if (!p.gcSubscriptionId) continue
    const list = paymentsBySub.get(p.gcSubscriptionId) ?? []
    list.push({ status: p.status, amountMinor: p.amountMinor, chargeDate: p.chargeDate })
    paymentsBySub.set(p.gcSubscriptionId, list)
  }

  const rows: PlanShortfall[] = []
  for (const sub of fixedLength) {
    const collected = collectedFromPayments(paymentsBySub.get(sub.gcSubscriptionId) ?? [])
    const row = classifyPlanShortfall({
      gcSubscriptionId: sub.gcSubscriptionId,
      name: sub.name,
      status: sub.status,
      amountMinor: sub.amountMinor,
      currency: sub.currency,
      totalPaymentCount: sub.totalPaymentCount,
      gcCustomerId: sub.gcCustomerId,
      startDate: sub.startDate,
      endDate: sub.endDate,
      gcCreatedAt: sub.gcCreatedAt,
      ...collected,
    })
    if (row) rows.push(row)
  }

  // Join customer + CRM link for display.
  const customerIds = Array.from(
    new Set(rows.map((r) => r.gcCustomerId).filter((id): id is string => id !== null)),
  )
  const customers =
    customerIds.length > 0
      ? await db.gcCustomer.findMany({
          where: { gcCustomerId: { in: customerIds }, deletedAt: null },
          select: {
            gcCustomerId: true,
            givenName: true,
            familyName: true,
            companyName: true,
            contactId: true,
            familyId: true,
          },
        })
      : []
  const customerById = new Map(customers.map((c) => [c.gcCustomerId, c]))

  const withCustomer: PlanShortfallWithCustomer[] = rows.map((r) => {
    const c = r.gcCustomerId ? customerById.get(r.gcCustomerId) : undefined
    const customerName = c
      ? [c.givenName, c.familyName].filter(Boolean).join(' ') || c.companyName || null
      : null
    return {
      ...r,
      customerName,
      contactId: c?.contactId ?? null,
      familyId: c?.familyId ?? null,
    }
  })

  withCustomer.sort((a, b) => b.shortfallMinor - a.shortfallMinor)
  return withCustomer
}

// -----------------------------------------------------------------------------
// Active plans behind schedule (arrears)
//
// The shortfall engine above only looks at *ended* plans. A plan that is still
// `active` but has quietly stopped collecting — the bank keeps declining, or
// GoCardless paused charging — leaks money for months before anyone cancels
// it. This second pass catches those: it estimates how many instalments a plan
// *should* have collected by now from its cadence and start date, and compares
// that to what actually landed.
//
// This is a deliberately conservative *proxy*, not GoCardless's exact
// scheduler (day-of-month, bank-holiday shifting and submission lead time all
// move real charge dates). We only flag a plan once it is at least
// `ARREARS_THRESHOLD` instalments behind, so a single in-flight cycle never
// raises a false alarm. GoCardless stays the source of truth; this only
// surfaces a plan for a human to check (CLAUDE.md §3, §4, §8).
// -----------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

/** Minimum instalments behind before a plan is surfaced as in arrears. */
export const ARREARS_THRESHOLD = 2

/** Whole calendar months between two UTC dates (a ≤ b assumed). */
function monthsBetweenUtc(a: Date, b: Date): number {
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth())
  if (b.getUTCDate() < a.getUTCDate()) months -= 1
  return Math.max(0, months)
}

export interface PlanScheduleInput {
  startDate: Date | null
  intervalUnit: string
  interval: number
  totalPaymentCount: number | null
}

/**
 * Estimate how many instalments a plan should have collected by `now`,
 * inclusive of the first charge at/after the start date. Returns null when the
 * cadence is unknown (fail closed, §8) or the plan has no start date. Capped at
 * the contracted total when one exists. Pure — time is injected for tests
 * (CLAUDE.md §30).
 */
export function expectedInstalmentsByNow(input: PlanScheduleInput, now: Date): number | null {
  if (!input.startDate) return null
  const start = input.startDate
  if (now.getTime() < start.getTime()) return 0

  const interval = input.interval > 0 ? input.interval : 1
  let cycles: number
  switch (input.intervalUnit) {
    case 'weekly':
      cycles = Math.floor(Math.floor((now.getTime() - start.getTime()) / DAY_MS) / (7 * interval))
      break
    case 'monthly':
      cycles = Math.floor(monthsBetweenUtc(start, now) / interval)
      break
    case 'yearly':
      cycles = Math.floor(monthsBetweenUtc(start, now) / (12 * interval))
      break
    default:
      return null
  }

  let expected = cycles + 1
  if (input.totalPaymentCount != null) expected = Math.min(expected, input.totalPaymentCount)
  return Math.max(0, expected)
}

export interface ActivePlanFacts extends PlanScheduleInput {
  gcSubscriptionId: string
  name: string | null
  status: string
  amountMinor: number
  currency: string
  gcCustomerId: string | null
  nextChargeAt: Date | null
  collectedCount: number
  collectedMinor: number
  lastCollectedAt: Date | null
}

export interface ActivePlanArrears {
  gcSubscriptionId: string
  name: string | null
  currency: string
  amountMinor: number
  intervalUnit: string
  interval: number
  startDate: Date
  /** Instalments the plan should have collected by now (cadence estimate). */
  expectedByNow: number
  collectedCount: number
  /** Instalments behind schedule = expectedByNow − collectedCount. */
  missedCount: number
  /** Estimated money in arrears = missedCount × amountMinor. */
  estimatedArrearsMinor: number
  totalPaymentCount: number | null
  nextChargeAt: Date | null
  lastCollectedAt: Date | null
  /** Representative date for the go-live cutoff (ADR 0045): the latest signal of
   *  activity — last collection, else next scheduled charge, else plan start. */
  issueDate: Date | null
  gcCustomerId: string | null
}

/**
 * Pure classifier. Flags an active plan that is at least `ARREARS_THRESHOLD`
 * instalments behind its expected schedule, else null.
 */
export function classifyActivePlanArrears(
  facts: ActivePlanFacts,
  now: Date,
): ActivePlanArrears | null {
  if (facts.status !== 'active') return null

  const expectedByNow = expectedInstalmentsByNow(facts, now)
  if (expectedByNow == null) return null

  const missedCount = expectedByNow - facts.collectedCount
  if (missedCount < ARREARS_THRESHOLD) return null

  return {
    gcSubscriptionId: facts.gcSubscriptionId,
    name: facts.name,
    currency: facts.currency,
    amountMinor: facts.amountMinor,
    intervalUnit: facts.intervalUnit,
    interval: facts.interval,
    startDate: facts.startDate as Date,
    expectedByNow,
    collectedCount: facts.collectedCount,
    missedCount,
    estimatedArrearsMinor: missedCount * facts.amountMinor,
    totalPaymentCount: facts.totalPaymentCount,
    nextChargeAt: facts.nextChargeAt,
    lastCollectedAt: facts.lastCollectedAt,
    issueDate: facts.lastCollectedAt ?? facts.nextChargeAt ?? (facts.startDate as Date),
    gcCustomerId: facts.gcCustomerId,
  }
}

export interface ActivePlanArrearsWithCustomer extends ActivePlanArrears {
  customerName: string | null
  contactId: string | null
  familyId: string | null
}

export interface ListActivePlanArrearsOptions {
  /** Reference time, injected for determinism in tests. Defaults to now. */
  now?: Date
}

/**
 * List active GoCardless plans that are behind their expected collection
 * schedule, sorted by estimated arrears desc. Read-only.
 */
export async function listActivePlanArrears(
  db: DbClient,
  opts: ListActivePlanArrearsOptions = {},
): Promise<ActivePlanArrearsWithCustomer[]> {
  const now = opts.now ?? new Date()

  const subscriptions = await db.gcSubscription.findMany({
    where: { deletedAt: null, status: 'active' },
    select: {
      gcSubscriptionId: true,
      name: true,
      status: true,
      amountMinor: true,
      currency: true,
      intervalUnit: true,
      interval: true,
      totalPaymentCount: true,
      startDate: true,
      nextChargeAt: true,
      gcCustomerId: true,
    },
  })
  if (subscriptions.length === 0) return []

  const subscriptionIds = subscriptions.map((s) => s.gcSubscriptionId)
  const payments = await db.gcPayment.findMany({
    where: { gcSubscriptionId: { in: subscriptionIds }, deletedAt: null },
    select: { gcSubscriptionId: true, status: true, amountMinor: true, chargeDate: true },
  })

  const paymentsBySub = new Map<
    string,
    Array<{ status: string; amountMinor: number; chargeDate: Date | null }>
  >()
  for (const p of payments) {
    if (!p.gcSubscriptionId) continue
    const list = paymentsBySub.get(p.gcSubscriptionId) ?? []
    list.push({ status: p.status, amountMinor: p.amountMinor, chargeDate: p.chargeDate })
    paymentsBySub.set(p.gcSubscriptionId, list)
  }

  const rows: ActivePlanArrears[] = []
  for (const sub of subscriptions) {
    const collected = collectedFromPayments(paymentsBySub.get(sub.gcSubscriptionId) ?? [])
    const row = classifyActivePlanArrears(
      {
        gcSubscriptionId: sub.gcSubscriptionId,
        name: sub.name,
        status: sub.status,
        amountMinor: sub.amountMinor,
        currency: sub.currency,
        intervalUnit: sub.intervalUnit,
        interval: sub.interval,
        totalPaymentCount: sub.totalPaymentCount,
        startDate: sub.startDate,
        nextChargeAt: sub.nextChargeAt,
        gcCustomerId: sub.gcCustomerId,
        ...collected,
      },
      now,
    )
    if (row) rows.push(row)
  }

  const customerIds = Array.from(
    new Set(rows.map((r) => r.gcCustomerId).filter((id): id is string => id !== null)),
  )
  const customers =
    customerIds.length > 0
      ? await db.gcCustomer.findMany({
          where: { gcCustomerId: { in: customerIds }, deletedAt: null },
          select: {
            gcCustomerId: true,
            givenName: true,
            familyName: true,
            companyName: true,
            contactId: true,
            familyId: true,
          },
        })
      : []
  const customerById = new Map(customers.map((c) => [c.gcCustomerId, c]))

  const withCustomer: ActivePlanArrearsWithCustomer[] = rows.map((r) => {
    const c = r.gcCustomerId ? customerById.get(r.gcCustomerId) : undefined
    const customerName = c
      ? [c.givenName, c.familyName].filter(Boolean).join(' ') || c.companyName || null
      : null
    return { ...r, customerName, contactId: c?.contactId ?? null, familyId: c?.familyId ?? null }
  })

  withCustomer.sort((a, b) => b.estimatedArrearsMinor - a.estimatedArrearsMinor)
  return withCustomer
}
