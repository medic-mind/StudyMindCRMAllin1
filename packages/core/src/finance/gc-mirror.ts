// Complete GoCardless provider mirror (ADR 0038): customers, mandates,
// subscriptions, payments. Wider population than the reconciliation-facing
// `Payment`/`GcMandate`-with-family rows — everything at the provider lands
// here so the CRM can show the full Direct Debit picture, including past
// (finished / cancelled) subscriptions.
//
// Linking model: the CRM link (contactId / familyId) lives on `GcCustomer`.
// Auto-linking happens only on a single unambiguous email match — never
// auto-merge (CLAUDE.md §3, §41.1). Everything else waits for a human in the
// Direct Debit workspace.
//
// Idempotency: every upsert is keyed on the GoCardless object id (unique in
// the DB). Repeating the same input is safe.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

type DbClient = PrismaClient | Prisma.TransactionClient

// Local mirrors of the Prisma enums so this module stays decoupled from the
// integration package (same pattern as sync-gocardless.ts).
export type GcSubscriptionStateValue =
  | 'pending_customer_approval'
  | 'customer_approval_denied'
  | 'active'
  | 'finished'
  | 'cancelled'
  | 'paused'
  | 'unknown'

export type GcPaymentStateValue =
  | 'pending_customer_approval'
  | 'pending_submission'
  | 'submitted'
  | 'confirmed'
  | 'paid_out'
  | 'cancelled'
  | 'customer_approval_denied'
  | 'failed'
  | 'charged_back'
  | 'unknown'

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

// -----------------------------------------------------------------------------
// Contact auto-matching (email). Pure decision + db lookup kept separate so the
// decision is unit-testable.
// -----------------------------------------------------------------------------

export interface ContactMatchCandidate {
  id: string
  familyId: string | null
}

/**
 * Pick the contact to auto-link, or null. Only a single unambiguous candidate
 * links automatically — two or more matches means a human decides (§41.1).
 */
export function pickUnambiguousContact(
  candidates: ContactMatchCandidate[],
): ContactMatchCandidate | null {
  if (candidates.length !== 1) return null
  return candidates[0] ?? null
}

/**
 * Find the contact (and its first family, if any) matching an email address.
 * Case-insensitive exact match on Contact.email, soft-deleted rows excluded.
 */
export async function findContactForGcEmail(
  db: DbClient,
  email: string,
): Promise<ContactMatchCandidate | null> {
  const trimmed = email.trim()
  if (!trimmed) return null
  const contacts = await db.contact.findMany({
    where: { email: { equals: trimmed, mode: 'insensitive' }, deletedAt: null },
    select: { id: true },
    take: 3,
  })
  const candidates: ContactMatchCandidate[] = []
  for (const contact of contacts) {
    const member = await db.familyMember.findFirst({
      where: { contactId: contact.id, family: { deletedAt: null } },
      select: { familyId: true },
      orderBy: { createdAt: 'asc' },
    })
    candidates.push({ id: contact.id, familyId: member?.familyId ?? null })
  }
  return pickUnambiguousContact(candidates)
}

// -----------------------------------------------------------------------------
// Customer mirror
// -----------------------------------------------------------------------------

export interface UpsertGcCustomerInput {
  gcCustomerId: string
  email?: string | null
  givenName?: string | null
  familyName?: string | null
  companyName?: string | null
  gcCreatedAt?: Date | null
  /** Try the unambiguous email auto-match when the row has no link yet. */
  autoMatch?: boolean
}

export interface UpsertGcCustomerResult {
  id: string
  contactId: string | null
  familyId: string | null
  /** True when this call auto-linked the customer to a contact. */
  autoLinked: boolean
}

export async function upsertGcCustomerMirror(
  db: DbClient,
  input: UpsertGcCustomerInput,
): Promise<UpsertGcCustomerResult> {
  const existing = await db.gcCustomer.findUnique({
    where: { gcCustomerId: input.gcCustomerId },
    select: { id: true, contactId: true, familyId: true },
  })

  const details = {
    email: input.email ?? null,
    givenName: input.givenName ?? null,
    familyName: input.familyName ?? null,
    companyName: input.companyName ?? null,
    gcCreatedAt: input.gcCreatedAt ?? null,
  }

  if (existing) {
    // Never overwrite an existing CRM link from a sync (CLAUDE.md §3).
    await db.gcCustomer.update({ where: { id: existing.id }, data: details })

    if (existing.contactId || !input.autoMatch || !input.email) {
      return {
        id: existing.id,
        contactId: existing.contactId,
        familyId: existing.familyId,
        autoLinked: false,
      }
    }
    const match = await findContactForGcEmail(db, input.email)
    if (!match) {
      return {
        id: existing.id,
        contactId: null,
        familyId: existing.familyId,
        autoLinked: false,
      }
    }
    await db.gcCustomer.update({
      where: { id: existing.id },
      data: { contactId: match.id, familyId: existing.familyId ?? match.familyId },
    })
    return {
      id: existing.id,
      contactId: match.id,
      familyId: existing.familyId ?? match.familyId,
      autoLinked: true,
    }
  }

  const match =
    input.autoMatch && input.email ? await findContactForGcEmail(db, input.email) : null

  const row = await db.gcCustomer.create({
    data: {
      id: createId(),
      gcCustomerId: input.gcCustomerId,
      ...details,
      contactId: match?.id ?? null,
      familyId: match?.familyId ?? null,
    },
    select: { id: true },
  })
  return {
    id: row.id,
    contactId: match?.id ?? null,
    familyId: match?.familyId ?? null,
    autoLinked: match !== null,
  }
}

// -----------------------------------------------------------------------------
// Mandate mirror (complete — creates rows even without a Family link, unlike
// the webhook-era syncGcMandate which required one)
// -----------------------------------------------------------------------------

export interface UpsertGcMandateMirrorInput {
  gcMandateId: string
  state: MandateStateValue
  gcCustomerId?: string | null
  reference?: string | null
  scheme?: string | null
  nextPossibleChargeDate?: Date | null
  gcCreatedAt?: Date | null
  /** Optional Family link — set when known, never cleared by a sync. */
  familyId?: string | null
}

export interface UpsertGcMandateMirrorResult {
  id: string
  familyId: string | null
}

export async function upsertGcMandateMirror(
  db: DbClient,
  input: UpsertGcMandateMirrorInput,
): Promise<UpsertGcMandateMirrorResult> {
  const stateForDb = ACCEPTED_MANDATE_STATES.has(input.state)
    ? (input.state as Exclude<MandateStateValue, 'unknown'>)
    : null

  const existing = await db.gcMandate.findUnique({
    where: { gcMandateId: input.gcMandateId },
    select: { id: true, familyId: true },
  })

  const details = {
    ...(input.gcCustomerId !== undefined ? { gcCustomerId: input.gcCustomerId } : {}),
    ...(input.reference !== undefined ? { reference: input.reference } : {}),
    ...(input.scheme !== undefined ? { scheme: input.scheme } : {}),
    ...(input.nextPossibleChargeDate !== undefined
      ? { nextPossibleChargeDate: input.nextPossibleChargeDate }
      : {}),
    ...(input.gcCreatedAt !== undefined ? { gcCreatedAt: input.gcCreatedAt } : {}),
  }

  if (existing) {
    await db.gcMandate.update({
      where: { id: existing.id },
      data: {
        ...details,
        ...(stateForDb ? { state: stateForDb } : {}),
        // Fill a missing Family link; never overwrite or clear one.
        ...(existing.familyId === null && input.familyId ? { familyId: input.familyId } : {}),
      },
    })
    return { id: existing.id, familyId: existing.familyId ?? input.familyId ?? null }
  }

  const row = await db.gcMandate.create({
    data: {
      id: createId(),
      gcMandateId: input.gcMandateId,
      state: stateForDb ?? 'pending_submission',
      familyId: input.familyId ?? null,
      ...details,
    },
    select: { id: true },
  })
  return { id: row.id, familyId: input.familyId ?? null }
}

// -----------------------------------------------------------------------------
// Subscription mirror
// -----------------------------------------------------------------------------

export interface UpsertGcSubscriptionInput {
  gcSubscriptionId: string
  status: GcSubscriptionStateValue
  amountMinor: number
  currency: string
  intervalUnit: string
  interval?: number
  dayOfMonth?: number | null
  name?: string | null
  startDate?: Date | null
  endDate?: Date | null
  nextChargeAt?: Date | null
  nextChargeMinor?: number | null
  /** GoCardless `count` — total payments for a fixed-length plan; null if open-ended. */
  totalPaymentCount?: number | null
  metadata?: Record<string, string> | null
  gcCreatedAt?: Date | null
  gcMandateId?: string | null
  gcCustomerId?: string | null
}

export async function upsertGcSubscriptionMirror(
  db: DbClient,
  input: UpsertGcSubscriptionInput,
): Promise<{ id: string }> {
  const data = {
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency.toUpperCase(),
    intervalUnit: input.intervalUnit,
    interval: input.interval ?? 1,
    dayOfMonth: input.dayOfMonth ?? null,
    name: input.name ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    nextChargeAt: input.nextChargeAt ?? null,
    nextChargeMinor: input.nextChargeMinor ?? null,
    totalPaymentCount: input.totalPaymentCount ?? null,
    metadata: input.metadata ?? undefined,
    gcCreatedAt: input.gcCreatedAt ?? null,
    ...(input.gcMandateId !== undefined ? { gcMandateId: input.gcMandateId } : {}),
    ...(input.gcCustomerId !== undefined ? { gcCustomerId: input.gcCustomerId } : {}),
  }

  const row = await db.gcSubscription.upsert({
    where: { gcSubscriptionId: input.gcSubscriptionId },
    create: { id: createId(), gcSubscriptionId: input.gcSubscriptionId, ...data },
    update: data,
    select: { id: true },
  })
  return { id: row.id }
}

// -----------------------------------------------------------------------------
// Payment mirror
// -----------------------------------------------------------------------------

export interface UpsertGcPaymentMirrorInput {
  gcPaymentId: string
  status: GcPaymentStateValue
  amountMinor: number
  currency: string
  description?: string | null
  chargeDate?: Date | null
  gcCreatedAt?: Date | null
  gcMandateId?: string | null
  gcCustomerId?: string | null
  gcSubscriptionId?: string | null
  gcPayoutId?: string | null
}

export async function upsertGcPaymentMirror(
  db: DbClient,
  input: UpsertGcPaymentMirrorInput,
): Promise<{ id: string }> {
  const data = {
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency.toUpperCase(),
    description: input.description ?? null,
    chargeDate: input.chargeDate ?? null,
    gcCreatedAt: input.gcCreatedAt ?? null,
    ...(input.gcMandateId !== undefined ? { gcMandateId: input.gcMandateId } : {}),
    ...(input.gcCustomerId !== undefined ? { gcCustomerId: input.gcCustomerId } : {}),
    ...(input.gcSubscriptionId !== undefined
      ? { gcSubscriptionId: input.gcSubscriptionId }
      : {}),
    // Only ever set forward — a refetch without payout context must not clear
    // the settled link.
    ...(input.gcPayoutId ? { gcPayoutId: input.gcPayoutId } : {}),
  }

  const row = await db.gcPayment.upsert({
    where: { gcPaymentId: input.gcPaymentId },
    create: { id: createId(), gcPaymentId: input.gcPaymentId, ...data },
    update: data,
    select: { id: true },
  })
  return { id: row.id }
}

// -----------------------------------------------------------------------------
// Payout mirror (ADR 0038 parity pass 2)
// -----------------------------------------------------------------------------

export interface UpsertGcPayoutInput {
  gcPayoutId: string
  /** Normalised text (pending | paid | bounced | …) — stored as-is, §15. */
  status: string
  amountMinor: number
  currency: string
  deductedFeesMinor?: number | null
  reference?: string | null
  payoutType?: string | null
  arrivalDate?: Date | null
  gcCreatedAt?: Date | null
}

export async function upsertGcPayoutMirror(
  db: DbClient,
  input: UpsertGcPayoutInput,
): Promise<{ id: string }> {
  const data = {
    status: input.status,
    amountMinor: input.amountMinor,
    currency: input.currency.toUpperCase(),
    deductedFeesMinor: input.deductedFeesMinor ?? null,
    reference: input.reference ?? null,
    payoutType: input.payoutType ?? null,
    arrivalDate: input.arrivalDate ?? null,
    gcCreatedAt: input.gcCreatedAt ?? null,
  }
  const row = await db.gcPayout.upsert({
    where: { gcPayoutId: input.gcPayoutId },
    create: { id: createId(), gcPayoutId: input.gcPayoutId, ...data },
    update: data,
    select: { id: true },
  })
  return { id: row.id }
}

// -----------------------------------------------------------------------------
// Manual linking (Direct Debit workspace). The caller audits.
// -----------------------------------------------------------------------------

export interface LinkGcCustomerResult {
  ok: boolean
  reason?: 'customer_not_found' | 'contact_not_found'
  contactId?: string | null
  familyId?: string | null
  /** Mandates that gained a Family link as a result. */
  linkedMandates?: number
}

/**
 * Link a GoCardless customer to a CRM contact (or clear the link with
 * contactId null). When the contact belongs to a Family, the link propagates
 * to the customer's mandates that lack one — which is what lets the existing
 * reconciliation/payment mirror pick them up.
 */
export async function linkGcCustomer(
  db: DbClient,
  input: { gcCustomerId: string; contactId: string | null },
): Promise<LinkGcCustomerResult> {
  const customer = await db.gcCustomer.findUnique({
    where: { gcCustomerId: input.gcCustomerId },
    select: { id: true },
  })
  if (!customer) return { ok: false, reason: 'customer_not_found' }

  if (input.contactId === null) {
    await db.gcCustomer.update({
      where: { id: customer.id },
      data: { contactId: null, familyId: null },
    })
    return { ok: true, contactId: null, familyId: null, linkedMandates: 0 }
  }

  const contact = await db.contact.findFirst({
    where: { id: input.contactId, deletedAt: null },
    select: { id: true },
  })
  if (!contact) return { ok: false, reason: 'contact_not_found' }

  const member = await db.familyMember.findFirst({
    where: { contactId: contact.id, family: { deletedAt: null } },
    select: { familyId: true },
    orderBy: { createdAt: 'asc' },
  })
  const familyId = member?.familyId ?? null

  await db.gcCustomer.update({
    where: { id: customer.id },
    data: { contactId: contact.id, familyId },
  })

  let linkedMandates = 0
  if (familyId) {
    const res = await db.gcMandate.updateMany({
      where: { gcCustomerId: input.gcCustomerId, familyId: null, deletedAt: null },
      data: { familyId },
    })
    linkedMandates = res.count
  }

  return { ok: true, contactId: contact.id, familyId, linkedMandates }
}

export interface BackfillLinkResult {
  scanned: number
  linked: number
}

/**
 * Re-attempt the unambiguous email auto-link for GoCardless customers that are
 * still unlinked. The import-time auto-match only fires when the matching CRM
 * contact already exists; a customer synced *before* its contact was created
 * stays orphaned forever, so its mandates/plans/payments never reach the
 * contact's Direct Debit panel. Running this after a contact import (or on a
 * schedule) closes that window.
 *
 * Unambiguous matches only — two contacts sharing an email is a human decision
 * (CLAUDE.md §3/§41.1), never an auto-merge. Linking propagates the Family to
 * the customer's orphaned mandates via `linkGcCustomer`, which is what lets the
 * reconciliation/defaulter pipeline pick them up.
 */
export async function linkUnlinkedGcCustomers(
  db: DbClient,
  opts: { limit?: number } = {},
): Promise<BackfillLinkResult> {
  const candidates = await db.gcCustomer.findMany({
    where: { contactId: null, deletedAt: null, email: { not: null } },
    select: { gcCustomerId: true, email: true },
    take: opts.limit ?? 500,
  })

  let linked = 0
  for (const candidate of candidates) {
    if (!candidate.email) continue
    const match = await findContactForGcEmail(db, candidate.email)
    if (!match) continue
    const res = await linkGcCustomer(db, {
      gcCustomerId: candidate.gcCustomerId,
      contactId: match.id,
    })
    if (res.ok && res.contactId) linked += 1
  }

  return { scanned: candidates.length, linked }
}
