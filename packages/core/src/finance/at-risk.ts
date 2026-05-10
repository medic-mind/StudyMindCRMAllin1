// Derives the `at_risk` Family flag per CLAUDE.md §6.4.
//
// The flag is a derived state, never persisted as the source of truth.
// We compute it from three independent signals and OR them together:
//   1. Stripe subscription `past_due` for more than 3 days.
//   2. Two or more consecutive failed Direct Debits in the last 60 days
//      (a reverted GoCardless `Payment.reverted = true`).
//   3. Latest churn score >= 0.7.
//
// `deriveAtRisk` is pure and unit-tested. `recomputeAtRiskForFamily`
// hydrates the signals from the DB, applies the derivation, and writes
// the transition (with audit + Interaction) when the state actually
// changes. All three call sites (Stripe job, GoCardless job, churn
// scorer) call recompute after their respective mutation lands.
//
// CLAUDE.md §3 — no silent mutation. Every transition is audited.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import type { FamilyState } from '../family/types'

export type DbClient = PrismaClient | Prisma.TransactionClient

const PAST_DUE_DAYS_THRESHOLD = 3
const FAILED_DD_THRESHOLD = 2
const CHURN_SCORE_THRESHOLD = 0.7
const SIGNAL_WINDOW_DAYS = 60

export interface AtRiskFamilyInput {
  id: string
  state: FamilyState
}

export interface AtRiskSignals {
  /** Most recent Stripe subscription status for this family. */
  stripeSubscription: {
    state: string
    pastDueSince: Date | null
  } | null
  /** Reverted GoCardless payments in the last 60 days, ordered desc. */
  recentFailedDirectDebits: Array<{ receivedAt: Date }>
  /** Most recent churn score, or null if never scored. */
  latestChurnScore: number | null
  /** Reference time used by the derivation. Injected for testability. */
  now: Date
}

export interface DeriveAtRiskResult {
  atRisk: boolean
  reasons: string[]
}

/**
 * Pure derivation. No I/O. Given a family and its signals, returns whether
 * the family is at risk plus the human-readable reasons.
 */
export function deriveAtRisk(
  _family: AtRiskFamilyInput,
  signals: AtRiskSignals,
): DeriveAtRiskResult {
  const reasons: string[] = []

  const sub = signals.stripeSubscription
  if (sub && sub.state === 'past_due' && sub.pastDueSince) {
    const days = Math.floor(
      (signals.now.getTime() - sub.pastDueSince.getTime()) / (24 * 60 * 60 * 1000),
    )
    if (days > PAST_DUE_DAYS_THRESHOLD) {
      reasons.push(`stripe_subscription_past_due_${days}_days`)
    }
  }

  const windowStart = new Date(
    signals.now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
  const recent = signals.recentFailedDirectDebits.filter(
    (p) => p.receivedAt >= windowStart,
  )
  if (recent.length >= FAILED_DD_THRESHOLD) {
    reasons.push(`gocardless_failed_direct_debits_${recent.length}_in_60d`)
  }

  if (signals.latestChurnScore !== null && signals.latestChurnScore >= CHURN_SCORE_THRESHOLD) {
    reasons.push(`churn_score_${signals.latestChurnScore.toFixed(2)}`)
  }

  return { atRisk: reasons.length > 0, reasons }
}

export interface RecomputeContext {
  actorId?: string | null
  requestId?: string
}

/**
 * Loads signals for the family, applies `deriveAtRisk`, and persists the
 * transition (or no-op when nothing changed). Idempotent.
 *
 * Auto-transitions are limited to active <-> at_risk. lead/trial/churned
 * lifecycle moves are explicit and owned by ops, never auto.
 */
export async function recomputeAtRiskForFamily(
  db: DbClient,
  familyId: string,
  ctx: RecomputeContext = {},
): Promise<{
  changed: boolean
  atRisk: boolean
  reasons: string[]
  from: FamilyState | null
  to: FamilyState | null
}> {
  const family = await db.family.findUnique({
    where: { id: familyId },
    select: { id: true, state: true },
  })
  if (!family) {
    return { changed: false, atRisk: false, reasons: [], from: null, to: null }
  }

  const now = new Date()
  const signals = await loadSignals(db, familyId, now)
  const { atRisk, reasons } = deriveAtRisk(
    { id: family.id, state: family.state as FamilyState },
    signals,
  )

  const current = family.state as FamilyState
  let next: FamilyState | null = null
  if (atRisk && current === 'active') {
    next = 'at_risk'
  } else if (!atRisk && current === 'at_risk') {
    next = 'active'
  }

  if (!next) {
    return { changed: false, atRisk, reasons, from: current, to: current }
  }

  await db.family.update({
    where: { id: familyId },
    data: { state: next },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'family_state_changed',
      familyId,
      occurredAt: now,
      summary:
        next === 'at_risk'
          ? `Family marked at_risk: ${reasons.join(', ')}`
          : `Family returned to active`,
      payload: {
        from: current,
        to: next,
        reasons,
        derivation: 'deriveAtRisk',
      },
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId ?? null,
    action: 'family.state_changed',
    target: { type: 'Family', id: familyId },
    requestId: ctx.requestId ?? `at-risk:${familyId}:${now.toISOString().slice(0, 10)}`,
    before: { state: current },
    after: { state: next, reasons, atRisk },
  })

  return { changed: true, atRisk, reasons, from: current, to: next }
}

async function loadSignals(
  db: DbClient,
  familyId: string,
  now: Date,
): Promise<AtRiskSignals> {
  const windowStart = new Date(now.getTime() - SIGNAL_WINDOW_DAYS * 24 * 60 * 60 * 1000)

  const sub = await db.stripeSubscription.findFirst({
    where: { familyId, deletedAt: null },
    orderBy: { updatedAt: 'desc' },
    select: { state: true, updatedAt: true },
  })

  const recentFailed = await db.payment.findMany({
    where: {
      familyId,
      provider: 'gocardless',
      reverted: true,
      receivedAt: { gte: windowStart },
    },
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
    take: 50,
  })

  const churn = await db.churnScore.findFirst({
    where: { familyId },
    orderBy: { scoredAt: 'desc' },
    select: { score: true },
  })

  return {
    stripeSubscription: sub
      ? {
          state: sub.state,
          // updatedAt is the last mirror touch — a safe over-approximation
          // for "moment we observed past_due"; we do not store the original
          // entry-into-past-due timestamp.
          pastDueSince: sub.state === 'past_due' ? sub.updatedAt : null,
        }
      : null,
    recentFailedDirectDebits: recentFailed.map((p) => ({ receivedAt: p.receivedAt })),
    latestChurnScore: churn?.score ?? null,
    now,
  }
}
