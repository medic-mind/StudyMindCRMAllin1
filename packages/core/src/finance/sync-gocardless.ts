// Map GoCardless canonical objects into our normalised mirror tables.
// CLAUDE.md §9: refetch from GoCardless — webhook payloads are notifications.
// This module accepts already-refetched objects and writes our DB.
//
// Idempotency: every operation is keyed on the GoCardless object id (unique
// in the DB). Repeating the same input is safe.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

// Local mirror of MandateState so this module stays decoupled from
// @studymind/integration-gocardless. The integration package maps from raw
// GoCardless statuses; we accept the already-mapped value here.
export type MandateStateValue =
  | 'pending_submission'
  | 'submitted'
  | 'active'
  | 'failed'
  | 'cancelled'
  | 'expired'
  | 'replaced'
  | 'unknown'

const ACCEPTED_MANDATE_STATES = new Set<MandateStateValue>([
  'pending_submission',
  'submitted',
  'active',
  'failed',
  'cancelled',
  'expired',
  'replaced',
])

/**
 * Resolve the Family that owns a GoCardless mandate id. Returns null if no
 * GcMandate row mirrors the mandate yet (first-time webhook for a mandate
 * that the CRM has not connected to a Family — common for sandbox tests).
 */
export async function resolveFamilyByGcMandate(
  db: DbClient,
  gcMandateId: string,
): Promise<string | null> {
  const row = await db.gcMandate.findUnique({
    where: { gcMandateId },
    select: { familyId: true },
  })
  return row?.familyId ?? null
}

export interface SyncGcMandateInput {
  gcMandateId: string
  state: MandateStateValue
  /** Required when creating a new GcMandate row. */
  familyId?: string
}

export interface SyncGcMandateResult {
  id: string
  familyId: string | null
  unresolved: boolean
}

/**
 * Upsert a GcMandate row keyed on the GoCardless mandate id.
 * If we cannot resolve a Family, returns `unresolved: true` so the caller
 * can surface a discrepancy (CLAUDE.md §3 forbids silent drops).
 */
export async function syncGcMandate(
  db: DbClient,
  input: SyncGcMandateInput,
): Promise<SyncGcMandateResult> {
  const existing = await db.gcMandate.findUnique({
    where: { gcMandateId: input.gcMandateId },
    select: { id: true, familyId: true },
  })

  const stateForDb = ACCEPTED_MANDATE_STATES.has(input.state)
    ? (input.state as Exclude<MandateStateValue, 'unknown'>)
    : null

  if (existing) {
    if (stateForDb) {
      await db.gcMandate.update({
        where: { id: existing.id },
        data: { state: stateForDb },
      })
    }
    return { id: existing.id, familyId: existing.familyId, unresolved: false }
  }

  // Creation requires a Family; otherwise we surface unresolved.
  if (!input.familyId) {
    return { id: '', familyId: null, unresolved: true }
  }

  const row = await db.gcMandate.create({
    data: {
      id: createId(),
      familyId: input.familyId,
      gcMandateId: input.gcMandateId,
      state: stateForDb ?? 'pending_submission',
    },
    select: { id: true },
  })
  return { id: row.id, familyId: input.familyId, unresolved: false }
}

/**
 * Mark the old mandate as replaced by the new one and persist the chain.
 * Both rows must already exist; the caller upserts the new mandate first.
 */
export async function linkReplacedMandate(
  db: DbClient,
  oldGcMandateId: string,
  newGcMandateId: string,
): Promise<void> {
  const newRow = await db.gcMandate.findUnique({
    where: { gcMandateId: newGcMandateId },
    select: { id: true },
  })
  if (!newRow) return
  await db.gcMandate.updateMany({
    where: { gcMandateId: oldGcMandateId },
    data: { state: 'replaced', replacedById: newRow.id },
  })
}

export interface SyncGcPaymentInput {
  gcPaymentId: string
  gcMandateId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  /** Set on `confirmed`; null/undefined leaves existing value. */
  confirmedAt?: Date | null
}

export interface SyncGcPaymentResult {
  id: string
  familyId: string | null
  unresolved: boolean
}

/**
 * Upsert a Payment row mirrored from GoCardless. `Payment.externalId` is the
 * GoCardless payment id, unique in the DB.
 */
export async function syncGcPayment(
  db: DbClient,
  input: SyncGcPaymentInput,
): Promise<SyncGcPaymentResult> {
  const familyId = await resolveFamilyByGcMandate(db, input.gcMandateId)
  if (!familyId) {
    return { id: '', familyId: null, unresolved: true }
  }

  const existing = await db.payment.findUnique({
    where: { externalId: input.gcPaymentId },
    select: { id: true },
  })

  if (existing) {
    await db.payment.update({
      where: { id: existing.id },
      data: {
        amountMinor: input.amountMinor,
        currency: input.currency,
        receivedAt: input.receivedAt,
        ...(input.confirmedAt !== undefined ? { confirmedAt: input.confirmedAt } : {}),
      },
    })
    return { id: existing.id, familyId, unresolved: false }
  }

  const row = await db.payment.create({
    data: {
      id: createId(),
      familyId,
      externalId: input.gcPaymentId,
      provider: 'gocardless',
      amountMinor: input.amountMinor,
      currency: input.currency,
      receivedAt: input.receivedAt,
      confirmedAt: input.confirmedAt ?? null,
    },
    select: { id: true },
  })
  return { id: row.id, familyId, unresolved: false }
}

/**
 * Reverse a previously-confirmed GoCardless payment after a late-failure
 * settles (CLAUDE.md §9). Marks the Payment.reverted, sets revertedAt,
 * deletes any Allocation rows so reconciliation can re-allocate, and flags
 * the FinancialAccount as `reverted_payment_pending_action` so finance can
 * act before dunning kicks in.
 */
export interface RevertGcPaymentInput {
  gcPaymentId: string
  occurredAt: Date
}

export interface RevertGcPaymentResult {
  paymentId: string | null
  familyId: string | null
  reopenedAllocations: number
}

export async function revertGcPayment(
  db: DbClient,
  input: RevertGcPaymentInput,
): Promise<RevertGcPaymentResult> {
  const payment = await db.payment.findUnique({
    where: { externalId: input.gcPaymentId },
    select: { id: true, familyId: true, reverted: true },
  })
  if (!payment) {
    return { paymentId: null, familyId: null, reopenedAllocations: 0 }
  }

  // Idempotent: already-reverted payment short-circuits.
  if (payment.reverted) {
    return { paymentId: payment.id, familyId: payment.familyId, reopenedAllocations: 0 }
  }

  // Soft-delete, never hard-delete (CLAUDE.md §3/§19): the reconcile engine
  // already excludes `deletedAt != null` allocations, so this reopens them for
  // re-allocation exactly as a hard delete did — but keeps the history + audit
  // trail of what was originally allocated against this now-reversed payment.
  const deleted = await db.allocation.updateMany({
    where: { paymentId: payment.id, deletedAt: null },
    data: { deletedAt: input.occurredAt },
  })

  await db.payment.update({
    where: { id: payment.id },
    data: {
      reverted: true,
      revertedAt: input.occurredAt,
    },
  })

  // Flag the FinancialAccount. Created if missing — every active Family
  // should have one but a webhook can race the first reconcile.
  const existingFa = await db.financialAccount.findUnique({
    where: { familyId: payment.familyId },
    select: { id: true },
  })
  if (existingFa) {
    await db.financialAccount.update({
      where: { id: existingFa.id },
      data: { status: 'reverted_payment_pending_action' },
    })
  } else {
    await db.financialAccount.create({
      data: {
        id: createId(),
        familyId: payment.familyId,
        status: 'reverted_payment_pending_action',
      },
    })
  }

  return {
    paymentId: payment.id,
    familyId: payment.familyId,
    reopenedAllocations: deleted.count,
  }
}
