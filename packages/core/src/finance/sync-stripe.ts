// Map Stripe canonical objects into our normalised mirror tables.
// CLAUDE.md §8: refetch from Stripe — webhook payloads are notifications.
// This module accepts already-refetched objects and writes our DB.
//
// Idempotency: every operation is keyed on the Stripe object id (unique in
// the DB). Repeating the same input is safe.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

export type DbClient = PrismaClient | Prisma.TransactionClient

// Local copies of the SubscriptionState union so this module does not depend
// on @studymind/integration-stripe. The integration package maps from raw
// Stripe statuses; we accept the already-mapped value here.
export type SubscriptionStateValue =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unknown'

export interface SyncStripeSubscriptionInput {
  stripeId: string
  stripeCustomerId: string
  state: SubscriptionStateValue
  currentPeriodEnd: Date | null
}

export interface SyncStripeSubscriptionResult {
  id: string
  familyId: string | null
  /** True when the subscription's family link could not be resolved (no StripeCustomer row). */
  unresolved: boolean
}

/**
 * Resolve the Family for a Stripe customer id. Returns null if no
 * StripeCustomer mapping exists (lead created on the Stripe side and not yet
 * connected to a Family in the CRM — common for first-time webhooks).
 */
export async function resolveFamilyByStripeCustomer(
  db: DbClient,
  stripeCustomerId: string,
): Promise<string | null> {
  const row = await db.stripeCustomer.findUnique({
    where: { stripeCustomerId },
    select: { familyId: true },
  })
  return row?.familyId ?? null
}

/**
 * Upsert a StripeSubscription row keyed on `stripeId`. If we cannot resolve a
 * Family for the customer, we skip the write and return `unresolved: true`
 * so the caller can raise a discrepancy (never a silent drop).
 */
export async function syncStripeSubscription(
  db: DbClient,
  input: SyncStripeSubscriptionInput,
): Promise<SyncStripeSubscriptionResult> {
  const familyId = await resolveFamilyByStripeCustomer(db, input.stripeCustomerId)
  if (!familyId) {
    return { id: '', familyId: null, unresolved: true }
  }

  const existing = await db.stripeSubscription.findUnique({
    where: { stripeId: input.stripeId },
    select: { id: true },
  })

  if (existing) {
    await db.stripeSubscription.update({
      where: { id: existing.id },
      data: {
        state: input.state,
        currentPeriodEnd: input.currentPeriodEnd,
      },
    })
    return { id: existing.id, familyId, unresolved: false }
  }

  const row = await db.stripeSubscription.create({
    data: {
      id: createId(),
      familyId,
      stripeId: input.stripeId,
      state: input.state,
      currentPeriodEnd: input.currentPeriodEnd,
    },
    select: { id: true },
  })
  return { id: row.id, familyId, unresolved: false }
}

export interface SyncStripeInvoiceInput {
  stripeInvoiceId: string
  stripeCustomerId: string
  amountDueMinor: number
  currency: string
  issuedAt: Date
  dueAt: Date | null
}

export interface SyncStripeInvoiceResult {
  id: string
  familyId: string | null
  unresolved: boolean
}

/**
 * Upsert an Invoice row mirrored from Stripe.
 * `Invoice.externalId` is the Stripe invoice id, unique in the DB.
 */
export async function syncStripeInvoice(
  db: DbClient,
  input: SyncStripeInvoiceInput,
): Promise<SyncStripeInvoiceResult> {
  const familyId = await resolveFamilyByStripeCustomer(db, input.stripeCustomerId)
  if (!familyId) {
    return { id: '', familyId: null, unresolved: true }
  }

  const existing = await db.invoice.findUnique({
    where: { externalId: input.stripeInvoiceId },
    select: { id: true },
  })

  if (existing) {
    await db.invoice.update({
      where: { id: existing.id },
      data: {
        amountMinor: input.amountDueMinor,
        currency: input.currency,
        issuedAt: input.issuedAt,
        dueAt: input.dueAt,
      },
    })
    return { id: existing.id, familyId, unresolved: false }
  }

  const row = await db.invoice.create({
    data: {
      id: createId(),
      familyId,
      externalId: input.stripeInvoiceId,
      amountMinor: input.amountDueMinor,
      currency: input.currency,
      issuedAt: input.issuedAt,
      dueAt: input.dueAt,
    },
    select: { id: true },
  })
  return { id: row.id, familyId, unresolved: false }
}

export interface SyncStripePaymentInput {
  /** The Stripe charge id — our Payment.externalId (unique, idempotent). */
  stripeChargeId: string
  stripeCustomerId: string
  amountMinor: number
  currency: string
  receivedAt: Date
  /** When the charge was confirmed/captured. Defaults to receivedAt. */
  confirmedAt?: Date | null
  /** The Stripe invoice id, when the charge settled an invoice we mirror. */
  stripeInvoiceId?: string | null
}

export interface SyncStripePaymentResult {
  id: string
  familyId: string | null
  unresolved: boolean
  created: boolean
}

/**
 * Upsert a Payment mirrored from a successful Stripe charge, keyed on the
 * charge id (`Payment.externalId`). Idempotent: a duplicate webhook updates the
 * existing row rather than creating a second payment. Returns `unresolved` when
 * no StripeCustomer→Family mapping exists — the caller surfaces it for a human
 * to link (CLAUDE.md §3: never auto-create, never silently drop).
 */
export async function syncStripePayment(
  db: DbClient,
  input: SyncStripePaymentInput,
): Promise<SyncStripePaymentResult> {
  const familyId = await resolveFamilyByStripeCustomer(db, input.stripeCustomerId)
  if (!familyId) {
    return { id: '', familyId: null, unresolved: true, created: false }
  }

  // Link to the mirrored Invoice when the charge settled one we know about.
  let invoiceId: string | null = null
  if (input.stripeInvoiceId) {
    const inv = await db.invoice.findUnique({
      where: { externalId: input.stripeInvoiceId },
      select: { id: true },
    })
    invoiceId = inv?.id ?? null
  }

  const existing = await db.payment.findUnique({
    where: { externalId: input.stripeChargeId },
    select: { id: true },
  })

  if (existing) {
    await db.payment.update({
      where: { id: existing.id },
      data: {
        amountMinor: input.amountMinor,
        currency: input.currency,
        confirmedAt: input.confirmedAt ?? input.receivedAt,
        ...(invoiceId ? { invoiceId } : {}),
      },
    })
    return { id: existing.id, familyId, unresolved: false, created: false }
  }

  const row = await db.payment.create({
    data: {
      id: createId(),
      familyId,
      invoiceId,
      externalId: input.stripeChargeId,
      provider: 'stripe',
      amountMinor: input.amountMinor,
      currency: input.currency,
      receivedAt: input.receivedAt,
      confirmedAt: input.confirmedAt ?? input.receivedAt,
    },
    select: { id: true },
  })
  return { id: row.id, familyId, unresolved: false, created: true }
}

export interface RevertStripePaymentInput {
  stripeChargeId: string
  revertedAt: Date
}

export interface RevertStripePaymentResult {
  id: string | null
  familyId: string | null
  /** True when no Payment row exists for the charge (refund before we saw it). */
  missing: boolean
  /** True when the payment was already reverted (idempotent no-op). */
  alreadyReverted: boolean
}

/**
 * Mark a mirrored Stripe Payment reverted (full refund / chargeback). Keyed on
 * the charge id. Idempotent. Reconciliation re-opens allocations off the
 * `reverted` flag (CLAUDE.md §9 reversal flow, shared with GoCardless).
 */
export async function revertStripePayment(
  db: DbClient,
  input: RevertStripePaymentInput,
): Promise<RevertStripePaymentResult> {
  const payment = await db.payment.findUnique({
    where: { externalId: input.stripeChargeId },
    select: { id: true, familyId: true, reverted: true },
  })
  if (!payment) {
    return { id: null, familyId: null, missing: true, alreadyReverted: false }
  }
  if (payment.reverted) {
    return { id: payment.id, familyId: payment.familyId, missing: false, alreadyReverted: true }
  }
  await db.payment.update({
    where: { id: payment.id },
    data: { reverted: true, revertedAt: input.revertedAt },
  })
  return { id: payment.id, familyId: payment.familyId, missing: false, alreadyReverted: false }
}
