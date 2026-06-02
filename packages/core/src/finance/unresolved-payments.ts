// Unresolved Stripe payments tray (ADR 0030 follow-up).
//
// A successful Stripe charge for a customer we cannot map to a Family lands here
// instead of being silently dropped (CLAUDE.md §3). Finance then either links it
// to a Family — which records the Payment AND creates the StripeCustomer mapping
// so future charges resolve automatically — or dismisses it. We never auto-create
// a Family from a payment; resolution is always human-confirmed.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { syncStripePayment } from './sync-stripe'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface RecordUnresolvedStripePaymentInput {
  stripeChargeId: string
  stripeCustomerId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  customerEmail?: string | null
  customerName?: string | null
  description?: string | null
  productHandles?: string[]
}

/**
 * Upsert an unresolved payment, keyed on the charge id. Idempotent: a duplicate
 * webhook refreshes the row's details but never creates a second entry, and a
 * row already resolved/dismissed is left untouched.
 */
export async function recordUnresolvedStripePayment(
  db: DbClient,
  input: RecordUnresolvedStripePaymentInput,
): Promise<{ id: string; created: boolean }> {
  const existing = await db.unresolvedStripePayment.findUnique({
    where: { stripeChargeId: input.stripeChargeId },
    select: { id: true, status: true },
  })

  if (existing) {
    if (existing.status === 'pending') {
      await db.unresolvedStripePayment.update({
        where: { id: existing.id },
        data: {
          stripeCustomerId: input.stripeCustomerId,
          amountMinor: input.amountMinor,
          currency: input.currency,
          receivedAt: input.receivedAt,
          customerEmail: input.customerEmail ?? null,
          customerName: input.customerName ?? null,
          description: input.description ?? null,
          productHandles: input.productHandles ?? [],
        },
      })
    }
    return { id: existing.id, created: false }
  }

  const row = await db.unresolvedStripePayment.create({
    data: {
      id: createId(),
      stripeChargeId: input.stripeChargeId,
      stripeCustomerId: input.stripeCustomerId,
      amountMinor: input.amountMinor,
      currency: input.currency,
      receivedAt: input.receivedAt,
      customerEmail: input.customerEmail ?? null,
      customerName: input.customerName ?? null,
      description: input.description ?? null,
      productHandles: input.productHandles ?? [],
    },
    select: { id: true },
  })
  return { id: row.id, created: true }
}

export interface UnresolvedStripePaymentRow {
  id: string
  stripeChargeId: string
  stripeCustomerId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  customerEmail: string | null
  customerName: string | null
  description: string | null
  productHandles: string[]
  createdAt: Date
}

/** List pending unresolved payments, newest first. */
export async function listUnresolvedStripePayments(
  db: DbClient,
): Promise<UnresolvedStripePaymentRow[]> {
  const rows = await db.unresolvedStripePayment.findMany({
    where: { status: 'pending' },
    orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
    take: 200,
    select: {
      id: true,
      stripeChargeId: true,
      stripeCustomerId: true,
      amountMinor: true,
      currency: true,
      receivedAt: true,
      customerEmail: true,
      customerName: true,
      description: true,
      productHandles: true,
      createdAt: true,
    },
  })
  return rows
}

export interface ResolveUnresolvedStripePaymentInput {
  id: string
  familyId: string
  actorId: string
}

export type ResolveUnresolvedStripePaymentResult =
  | { ok: false; reason: 'not_found' | 'not_pending' | 'family_not_found' }
  | { ok: true; paymentId: string; familyId: string }

/**
 * Link an unresolved payment to a Family. Creates the StripeCustomer→Family
 * mapping (so future charges for that customer resolve automatically), records
 * the Payment, and marks the row resolved. Human-confirmed (CLAUDE.md §3); the
 * caller supplies `actorId` and audits at the tRPC layer.
 */
export async function resolveUnresolvedStripePayment(
  db: DbClient,
  input: ResolveUnresolvedStripePaymentInput,
): Promise<ResolveUnresolvedStripePaymentResult> {
  const row = await db.unresolvedStripePayment.findUnique({
    where: { id: input.id },
  })
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' }

  const family = await db.family.findFirst({
    where: { id: input.familyId, deletedAt: null },
    select: { id: true },
  })
  if (!family) return { ok: false, reason: 'family_not_found' }

  // Create the StripeCustomer→Family mapping if it does not already exist, so
  // syncStripePayment resolves and every future charge auto-resolves too.
  const mapping = await db.stripeCustomer.findUnique({
    where: { stripeCustomerId: row.stripeCustomerId },
    select: { id: true },
  })
  if (!mapping) {
    await db.stripeCustomer.create({
      data: {
        id: createId(),
        familyId: input.familyId,
        stripeCustomerId: row.stripeCustomerId,
        createdById: input.actorId,
      },
    })
  }

  const payment = await syncStripePayment(db, {
    stripeChargeId: row.stripeChargeId,
    stripeCustomerId: row.stripeCustomerId,
    amountMinor: row.amountMinor,
    currency: row.currency,
    receivedAt: row.receivedAt,
  })

  await db.unresolvedStripePayment.update({
    where: { id: row.id },
    data: {
      status: 'resolved',
      resolvedFamilyId: input.familyId,
      resolvedPaymentId: payment.id,
      resolvedAt: new Date(),
      resolvedById: input.actorId,
      updatedById: input.actorId,
    },
  })

  return { ok: true, paymentId: payment.id, familyId: input.familyId }
}

export interface DismissUnresolvedStripePaymentInput {
  id: string
  reason: string
  actorId: string
}

export type DismissUnresolvedStripePaymentResult =
  | { ok: false; reason: 'not_found' | 'not_pending' }
  | { ok: true; id: string }

/** Dismiss an unresolved payment (e.g. test charge, refunded, not ours). */
export async function dismissUnresolvedStripePayment(
  db: DbClient,
  input: DismissUnresolvedStripePaymentInput,
): Promise<DismissUnresolvedStripePaymentResult> {
  const row = await db.unresolvedStripePayment.findUnique({
    where: { id: input.id },
    select: { id: true, status: true },
  })
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.status !== 'pending') return { ok: false, reason: 'not_pending' }

  await db.unresolvedStripePayment.update({
    where: { id: row.id },
    data: {
      status: 'dismissed',
      dismissReason: input.reason,
      resolvedAt: new Date(),
      resolvedById: input.actorId,
      updatedById: input.actorId,
    },
  })
  return { ok: true, id: row.id }
}
