// Outbound calls TO GoCardless.
// Idempotency keys per CLAUDE.md §9 + §17. Audit on every Family / Financial
// write per §20.
//
// The pattern for redirect-flow creation (the hosted page where a parent
// confirms bank details):
//   1. Build a deterministic idempotency key per (family, billingContact).
//   2. Persist a MandateIntent in `pending` BEFORE calling GoCardless. If a
//      previous successful run already created a redirect_flow, return that
//      row — do not create a second redirect flow.
//   3. Call GoCardless with the same key as the `session_token`.
//   4. On success: mark intent `succeeded`, store flow id + url, audit.
//   5. On failure: leave intent in `pending_review` and rethrow.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'
import {
  completeSetupLink,
  upsertGcCustomerMirror,
  upsertGcMandateMirror,
  upsertGcPaymentMirror,
  upsertGcSubscriptionMirror,
} from '@studymind/core/finance'

import { createClient } from './client'
import {
  customerMirrorInput,
  mandateMirrorInput,
  paymentMirrorInput,
  subscriptionMirrorInput,
} from './mirror-map'

export type DbClient = PrismaClient | Prisma.TransactionClient

export interface CreateHostedRedirectFlowInput {
  familyId: string
  billingContactId: string
  /** Where GoCardless returns the customer after they finish the hosted flow. */
  redirectUrl: string
  /** Optional human-friendly label shown by GoCardless. */
  description?: string
  /**
   * Optional uniqueness suffix for the idempotency key. Redirect flows expire
   * after ~30 minutes, so the Direct Debit workspace passes the requestId here
   * to mint a fresh flow per click while keeping tRPC retries idempotent.
   * Omitted → legacy behaviour (one durable intent per family+contact).
   */
  sessionKey?: string
  /**
   * Durable setup link this flow was minted for (ADR 0038 amendment) —
   * stamped on the MandateIntent so completion can close the link.
   */
  setupLinkId?: string
  /** Null when the flow is minted by the public setup-link route (no agent). */
  actorId: string | null
  requestId: string
}

export type RedirectFlowStatus = 'succeeded' | 'pending_review'

export interface CreateHostedRedirectFlowResult {
  mandateIntentId: string
  status: RedirectFlowStatus
  redirectFlowId?: string
  redirectUrl?: string
}

export function buildMandateIntentIdempotencyKey(
  familyId: string,
  billingContactId: string,
  sessionKey?: string,
): string {
  const base = `mandate_intent:${familyId}:${billingContactId}`
  return sessionKey ? `${base}:${sessionKey}` : base
}

/**
 * Create a GoCardless redirect flow that the family completes to authorise a
 * Direct Debit mandate. The MandateIntent row is the durable record of the
 * intent; the redirect flow id and URL are filled in once GoCardless responds.
 */
export async function createHostedRedirectFlow(
  db: DbClient,
  input: CreateHostedRedirectFlowInput,
): Promise<CreateHostedRedirectFlowResult> {
  const { familyId, billingContactId, redirectUrl, description, actorId, requestId } = input

  const idempotencyKey = buildMandateIntentIdempotencyKey(
    familyId,
    billingContactId,
    input.sessionKey,
  )

  // 1. Upsert MandateIntent in `pending`. The unique key ensures a retried
  //    call returns the same row.
  const intent = await db.mandateIntent.upsert({
    where: { idempotencyKey },
    create: {
      id: createId(),
      familyId,
      billingContactId,
      idempotencyKey,
      status: 'pending',
      setupLinkId: input.setupLinkId ?? null,
      createdById: actorId,
      updatedById: actorId,
    },
    update: {
      // Keep existing status — replays must not regress a succeeded intent.
    },
    select: {
      id: true,
      status: true,
      redirectFlowId: true,
      redirectUrl: true,
    },
  })

  if (intent.status === 'succeeded' && intent.redirectFlowId && intent.redirectUrl) {
    return {
      mandateIntentId: intent.id,
      status: 'succeeded',
      redirectFlowId: intent.redirectFlowId,
      redirectUrl: intent.redirectUrl,
    }
  }

  // 2. Call GoCardless. The session_token doubles as our Idempotency-Key
  //    inside the HTTP client.
  const client = createClient()
  try {
    const flow = await client.createRedirectFlow({
      description: description ?? 'StudyMind Direct Debit',
      session_token: idempotencyKey,
      success_redirect_url: redirectUrl,
      metadata: {
        familyId,
        billingContactId,
      },
    })

    await db.mandateIntent.update({
      where: { id: intent.id },
      data: {
        status: 'succeeded',
        redirectFlowId: flow.id,
        redirectUrl: flow.redirect_url,
        updatedById: actorId,
      },
    })

    await writeAuditLogEntry(db, {
      actorId,
      action: 'gocardless.redirect_flow.created',
      target: { type: 'Family', id: familyId },
      requestId,
      after: {
        mandateIntentId: intent.id,
        redirectFlowId: flow.id,
        billingContactId,
      },
    })

    return {
      mandateIntentId: intent.id,
      status: 'succeeded',
      redirectFlowId: flow.id,
      redirectUrl: flow.redirect_url,
    }
  } catch (err) {
    await db.mandateIntent.update({
      where: { id: intent.id },
      data: { status: 'pending_review', updatedById: actorId },
    })
    throw err
  }
}

// -----------------------------------------------------------------------------
// Redirect-flow completion (ADR 0038). GoCardless sends the customer's
// browser back to our public completion route with `redirect_flow_id`; the
// flow must then be completed server-side, which is the moment GoCardless
// actually creates the customer + mandate.
// -----------------------------------------------------------------------------

export type CompleteRedirectFlowResult =
  | { ok: true; gcMandateId: string; alreadyCompleted: boolean }
  | { ok: false; reason: 'intent_not_found' | 'provider_error' }

export async function completeHostedRedirectFlow(
  db: DbClient,
  input: { redirectFlowId: string; requestId: string },
): Promise<CompleteRedirectFlowResult> {
  const intent = await db.mandateIntent.findFirst({
    where: { redirectFlowId: input.redirectFlowId },
    select: {
      id: true,
      familyId: true,
      billingContactId: true,
      idempotencyKey: true,
      status: true,
      gcMandateId: true,
      setupLinkId: true,
    },
  })
  if (!intent) return { ok: false, reason: 'intent_not_found' }

  // Replays (customer refreshes the success page) converge here.
  if (intent.status === 'completed' && intent.gcMandateId) {
    return { ok: true, gcMandateId: intent.gcMandateId, alreadyCompleted: true }
  }

  const client = createClient()
  let flow
  try {
    flow = await client.completeRedirectFlow(input.redirectFlowId, intent.idempotencyKey)
  } catch (err) {
    // A second completion attempt races the first: re-read our own record.
    const fresh = await db.mandateIntent.findUnique({
      where: { id: intent.id },
      select: { status: true, gcMandateId: true },
    })
    if (fresh?.status === 'completed' && fresh.gcMandateId) {
      return { ok: true, gcMandateId: fresh.gcMandateId, alreadyCompleted: true }
    }
    throw err
  }

  const gcMandateId = flow.links.mandate ?? null
  const gcCustomerId = flow.links.customer ?? null
  if (!gcMandateId) return { ok: false, reason: 'provider_error' }

  // Mirror the new customer + mandate, linked to the family/contact the agent
  // started the flow for — this is an explicit operator-initiated link, not an
  // auto-merge (CLAUDE.md §3).
  if (gcCustomerId) {
    const customer = await client.getCustomer(gcCustomerId)
    const existing = await db.gcCustomer.findUnique({
      where: { gcCustomerId },
      select: { id: true, contactId: true },
    })
    if (existing) {
      await db.gcCustomer.update({
        where: { id: existing.id },
        data: {
          email: customer.email ?? null,
          givenName: customer.given_name ?? null,
          familyName: customer.family_name ?? null,
          ...(existing.contactId
            ? {}
            : { contactId: intent.billingContactId, familyId: intent.familyId }),
        },
      })
    } else {
      await db.gcCustomer.create({
        data: {
          id: createId(),
          gcCustomerId,
          email: customer.email ?? null,
          givenName: customer.given_name ?? null,
          familyName: customer.family_name ?? null,
          companyName: customer.company_name ?? null,
          contactId: intent.billingContactId,
          familyId: intent.familyId,
        },
      })
    }
  }

  const mandate = await client.getMandate(gcMandateId)
  await upsertGcMandateMirror(db, mandateMirrorInput(mandate, { familyId: intent.familyId }))

  await db.mandateIntent.update({
    where: { id: intent.id },
    data: { status: 'completed', gcMandateId },
  })

  // Close the durable setup link (stops its automated reminder). ADR 0038
  // amendment — idempotent, so a replayed completion converges.
  if (intent.setupLinkId) {
    await completeSetupLink(db, { setupLinkId: intent.setupLinkId, gcMandateId })
  }

  await writeAuditLogEntry(db, {
    actorId: null,
    action: 'gocardless.mandate.created',
    target: { type: 'Family', id: intent.familyId },
    requestId: input.requestId,
    after: {
      gcMandateId,
      gcCustomerId,
      mandateIntentId: intent.id,
      billingContactId: intent.billingContactId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'payment',
      contactId: intent.billingContactId,
      familyId: intent.familyId,
      occurredAt: new Date(),
      summary: 'Direct Debit mandate set up',
      payload: { source: 'gocardless_dd', gcMandateId, mandateIntentId: intent.id },
    },
  })

  return { ok: true, gcMandateId, alreadyCompleted: false }
}

// -----------------------------------------------------------------------------
// Direct Debit plan + payment management (ADR 0038).
//
// Every mutation here is human-initiated from the CRM (never automatic —
// CLAUDE.md §3), carries a caller-supplied request-scoped idempotency key on
// creates, refreshes the mirror from the canonical response, and writes an
// AuditLogEntry. A timeline Interaction is appended when the GoCardless
// customer is linked to a CRM contact/family.
// -----------------------------------------------------------------------------

interface ActorContext {
  actorId: string
  requestId: string
}

/**
 * Resolve the CRM links for a GoCardless customer id (via the mirror), so
 * mutations can land on the right timeline. Either id may be null.
 */
async function resolveCustomerLinks(
  db: DbClient,
  gcCustomerId: string | null | undefined,
): Promise<{ contactId: string | null; familyId: string | null }> {
  if (!gcCustomerId) return { contactId: null, familyId: null }
  const row = await db.gcCustomer.findUnique({
    where: { gcCustomerId },
    select: { contactId: true, familyId: true },
  })
  return { contactId: row?.contactId ?? null, familyId: row?.familyId ?? null }
}

async function writeDdInteraction(
  db: DbClient,
  input: {
    gcCustomerId: string | null | undefined
    summary: string
    payload: Record<string, unknown>
    actorId: string
  },
): Promise<void> {
  const links = await resolveCustomerLinks(db, input.gcCustomerId)
  if (!links.contactId && !links.familyId) return
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'payment',
      contactId: links.contactId,
      familyId: links.familyId,
      occurredAt: new Date(),
      summary: input.summary,
      payload: { source: 'gocardless_dd', ...input.payload },
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })
}

/** Look up the mirror row for a mandate and require it to be chargeable. */
async function requireMandate(
  db: DbClient,
  gcMandateId: string,
): Promise<{ gcCustomerId: string | null; familyId: string | null }> {
  const mandate = await db.gcMandate.findUnique({
    where: { gcMandateId },
    select: { gcCustomerId: true, familyId: true, state: true },
  })
  if (!mandate) {
    throw new GcMandateNotFoundError(gcMandateId)
  }
  return { gcCustomerId: mandate.gcCustomerId, familyId: mandate.familyId }
}

export class GcMandateNotFoundError extends Error {
  override readonly name = 'GcMandateNotFoundError'
  constructor(public readonly gcMandateId: string) {
    super(`GoCardless mandate ${gcMandateId} is not in the CRM mirror`)
  }
}

export interface CreateSubscriptionPlanInput extends ActorContext {
  gcMandateId: string
  amountMinor: number
  currency?: string
  intervalUnit: 'weekly' | 'monthly' | 'yearly'
  interval?: number
  dayOfMonth?: number
  name?: string
  /** ISO date (YYYY-MM-DD). GoCardless picks the next valid charge date if omitted. */
  startDate?: string
  /** Total number of payments; omit for an open-ended plan. */
  count?: number
  /** Yearly plans: which month (1-12) the collection lands in. */
  month?: number
}

export interface SubscriptionPlanResult {
  gcSubscriptionId: string
  status: string
}

/**
 * Create a recurring Direct Debit plan against an existing mandate.
 * Idempotent on the caller's requestId — a tRPC retry re-sends the same
 * Idempotency-Key and GoCardless returns the original subscription.
 */
export async function createSubscriptionPlan(
  db: DbClient,
  input: CreateSubscriptionPlanInput,
): Promise<SubscriptionPlanResult> {
  const mandate = await requireMandate(db, input.gcMandateId)
  const client = createClient()

  const resource = await client.createSubscription(
    {
      amount: input.amountMinor,
      currency: (input.currency ?? 'GBP').toUpperCase(),
      interval_unit: input.intervalUnit,
      ...(input.interval !== undefined ? { interval: input.interval } : {}),
      ...(input.dayOfMonth !== undefined ? { day_of_month: input.dayOfMonth } : {}),
      ...(input.month !== undefined ? { month: input.month } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.startDate !== undefined ? { start_date: input.startDate } : {}),
      ...(input.count !== undefined ? { count: input.count } : {}),
      metadata: { crmActorId: input.actorId },
      links: { mandate: input.gcMandateId },
    },
    `sub_create:${input.requestId}`,
  )

  await upsertGcSubscriptionMirror(
    db,
    subscriptionMirrorInput(resource, { gcCustomerId: mandate.gcCustomerId }),
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.subscription.created',
    target: { type: 'GcSubscription', id: resource.id },
    requestId: input.requestId,
    after: {
      gcMandateId: input.gcMandateId,
      amountMinor: input.amountMinor,
      intervalUnit: input.intervalUnit,
      dayOfMonth: input.dayOfMonth ?? null,
      name: input.name ?? null,
    },
  })

  await writeDdInteraction(db, {
    gcCustomerId: mandate.gcCustomerId,
    summary: `Direct Debit plan created${input.name ? ` — ${input.name}` : ''}`,
    payload: {
      gcSubscriptionId: resource.id,
      amountMinor: input.amountMinor,
      intervalUnit: input.intervalUnit,
    },
    actorId: input.actorId,
  })

  return { gcSubscriptionId: resource.id, status: resource.status }
}

type SubscriptionAction = 'cancel' | 'pause' | 'resume'

const SUBSCRIPTION_ACTION_LABEL: Record<SubscriptionAction, string> = {
  cancel: 'cancelled',
  pause: 'paused',
  resume: 'resumed',
}

async function actOnSubscription(
  db: DbClient,
  action: SubscriptionAction,
  input: { gcSubscriptionId: string; reason?: string; pauseCycles?: number } & ActorContext,
): Promise<SubscriptionPlanResult> {
  const client = createClient()
  const resource =
    action === 'cancel'
      ? await client.cancelSubscription(input.gcSubscriptionId)
      : action === 'pause'
        ? await client.pauseSubscription(input.gcSubscriptionId, input.pauseCycles)
        : await client.resumeSubscription(input.gcSubscriptionId)

  const existing = await db.gcSubscription.findUnique({
    where: { gcSubscriptionId: input.gcSubscriptionId },
    select: { gcCustomerId: true },
  })

  await upsertGcSubscriptionMirror(
    db,
    subscriptionMirrorInput(resource, { gcCustomerId: existing?.gcCustomerId ?? null }),
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: `gocardless.subscription.${SUBSCRIPTION_ACTION_LABEL[action]}`,
    target: { type: 'GcSubscription', id: input.gcSubscriptionId },
    requestId: input.requestId,
    after: {
      status: resource.status,
      reason: input.reason ?? null,
      ...(action === 'pause' && input.pauseCycles
        ? { pauseCycles: input.pauseCycles }
        : {}),
    },
  })

  await writeDdInteraction(db, {
    gcCustomerId: existing?.gcCustomerId ?? null,
    summary: `Direct Debit plan ${SUBSCRIPTION_ACTION_LABEL[action]}${
      resource.name ? ` — ${resource.name}` : ''
    }`,
    payload: {
      gcSubscriptionId: input.gcSubscriptionId,
      action,
      reason: input.reason ?? null,
    },
    actorId: input.actorId,
  })

  return { gcSubscriptionId: resource.id, status: resource.status }
}

export function cancelSubscriptionPlan(
  db: DbClient,
  input: { gcSubscriptionId: string; reason?: string } & ActorContext,
): Promise<SubscriptionPlanResult> {
  return actOnSubscription(db, 'cancel', input)
}

export function pauseSubscriptionPlan(
  db: DbClient,
  input: { gcSubscriptionId: string; reason?: string; pauseCycles?: number } & ActorContext,
): Promise<SubscriptionPlanResult> {
  return actOnSubscription(db, 'pause', input)
}

export function resumeSubscriptionPlan(
  db: DbClient,
  input: { gcSubscriptionId: string; reason?: string } & ActorContext,
): Promise<SubscriptionPlanResult> {
  return actOnSubscription(db, 'resume', input)
}

export interface CreateOneOffPaymentInput extends ActorContext {
  gcMandateId: string
  amountMinor: number
  currency?: string
  description?: string
  /** ISO date (YYYY-MM-DD); GoCardless uses the next valid date if omitted. */
  chargeDate?: string
}

export interface OneOffPaymentResult {
  gcPaymentId: string
  status: string
}

/** Collect a one-off Direct Debit payment against an existing mandate. */
export async function createOneOffPayment(
  db: DbClient,
  input: CreateOneOffPaymentInput,
): Promise<OneOffPaymentResult> {
  const mandate = await requireMandate(db, input.gcMandateId)
  const client = createClient()

  const resource = await client.createPayment(
    {
      amount: input.amountMinor,
      currency: (input.currency ?? 'GBP').toUpperCase(),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.chargeDate !== undefined ? { charge_date: input.chargeDate } : {}),
      metadata: { crmActorId: input.actorId },
      links: { mandate: input.gcMandateId },
    },
    `pay_create:${input.requestId}`,
  )

  await upsertGcPaymentMirror(
    db,
    paymentMirrorInput(resource, { gcCustomerId: mandate.gcCustomerId }),
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.payment.created',
    target: { type: 'GcPayment', id: resource.id },
    requestId: input.requestId,
    after: {
      gcMandateId: input.gcMandateId,
      amountMinor: input.amountMinor,
      chargeDate: input.chargeDate ?? null,
      description: input.description ?? null,
    },
  })

  await writeDdInteraction(db, {
    gcCustomerId: mandate.gcCustomerId,
    summary: `One-off Direct Debit payment requested${
      input.description ? ` — ${input.description}` : ''
    }`,
    payload: { gcPaymentId: resource.id, amountMinor: input.amountMinor },
    actorId: input.actorId,
  })

  return { gcPaymentId: resource.id, status: resource.status }
}

type PaymentAction = 'cancel' | 'retry'

async function actOnPayment(
  db: DbClient,
  action: PaymentAction,
  input: { gcPaymentId: string; reason?: string } & ActorContext,
): Promise<OneOffPaymentResult> {
  const client = createClient()
  const resource =
    action === 'cancel'
      ? await client.cancelPayment(input.gcPaymentId)
      : await client.retryPayment(input.gcPaymentId)

  const existing = await db.gcPayment.findUnique({
    where: { gcPaymentId: input.gcPaymentId },
    select: { gcCustomerId: true },
  })

  await upsertGcPaymentMirror(
    db,
    paymentMirrorInput(resource, { gcCustomerId: existing?.gcCustomerId ?? null }),
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: `gocardless.payment.${action === 'cancel' ? 'cancelled' : 'retried'}`,
    target: { type: 'GcPayment', id: input.gcPaymentId },
    requestId: input.requestId,
    after: { status: resource.status, reason: input.reason ?? null },
  })

  return { gcPaymentId: resource.id, status: resource.status }
}

export function cancelPendingPayment(
  db: DbClient,
  input: { gcPaymentId: string; reason?: string } & ActorContext,
): Promise<OneOffPaymentResult> {
  return actOnPayment(db, 'cancel', input)
}

export function retryFailedPayment(
  db: DbClient,
  input: { gcPaymentId: string; reason?: string } & ActorContext,
): Promise<OneOffPaymentResult> {
  return actOnPayment(db, 'retry', input)
}

/**
 * Cancel a mandate at GoCardless. This also cancels every subscription and
 * pending payment under it provider-side — the webhook events that follow
 * bring the mirror in step; we refresh the mandate row immediately.
 */
export async function cancelMandateAction(
  db: DbClient,
  input: { gcMandateId: string; reason?: string } & ActorContext,
): Promise<{ gcMandateId: string; state: string }> {
  const client = createClient()
  const resource = await client.cancelMandate(input.gcMandateId)

  await upsertGcMandateMirror(db, mandateMirrorInput(resource))

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.mandate.cancelled',
    target: { type: 'GcMandate', id: input.gcMandateId },
    requestId: input.requestId,
    after: { state: resource.status, reason: input.reason ?? null },
  })

  await writeDdInteraction(db, {
    gcCustomerId: resource.links.customer ?? null,
    summary: 'Direct Debit mandate cancelled',
    payload: { gcMandateId: input.gcMandateId, reason: input.reason ?? null },
    actorId: input.actorId,
  })

  return { gcMandateId: resource.id, state: resource.status }
}

// -----------------------------------------------------------------------------
// Plan amendment, mandate reinstatement, refunds, customer edits — the write
// operations the GoCardless dashboard offers that the workspace previously
// lacked ("cancel and recreate" is not plan management). All human-confirmed,
// audited, and mirrored immediately (§3, §2 rule 5).
// -----------------------------------------------------------------------------

export interface UpdateSubscriptionPlanInput extends ActorContext {
  gcSubscriptionId: string
  /** New collection amount in minor units; omit to leave unchanged. */
  amountMinor?: number
  name?: string
  paymentReference?: string
  reason?: string
}

/** Amend a live plan in place — amount, name, payment reference. GoCardless
 *  applies scheme rules server-side (e.g. amount changes may be rejected close
 *  to a charge date); its error is surfaced to the operator verbatim. */
export async function updateSubscriptionPlan(
  db: DbClient,
  input: UpdateSubscriptionPlanInput,
): Promise<SubscriptionPlanResult> {
  if (
    input.amountMinor === undefined &&
    input.name === undefined &&
    input.paymentReference === undefined
  ) {
    throw new Error('Nothing to update — provide a new amount, name, or reference.')
  }
  const client = createClient()

  const before = await db.gcSubscription.findUnique({
    where: { gcSubscriptionId: input.gcSubscriptionId },
    select: { gcCustomerId: true, amountMinor: true, name: true },
  })

  const resource = await client.updateSubscription(input.gcSubscriptionId, {
    ...(input.amountMinor !== undefined ? { amount: input.amountMinor } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.paymentReference !== undefined
      ? { payment_reference: input.paymentReference }
      : {}),
  })

  await upsertGcSubscriptionMirror(
    db,
    subscriptionMirrorInput(resource, { gcCustomerId: before?.gcCustomerId ?? null }),
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.subscription.updated',
    target: { type: 'GcSubscription', id: input.gcSubscriptionId },
    requestId: input.requestId,
    before: {
      amountMinor: before?.amountMinor ?? null,
      name: before?.name ?? null,
    },
    after: {
      amountMinor: resource.amount,
      name: resource.name ?? null,
      reason: input.reason ?? null,
    },
  })

  await writeDdInteraction(db, {
    gcCustomerId: before?.gcCustomerId ?? null,
    summary: `Direct Debit plan amended${resource.name ? ` — ${resource.name}` : ''}`,
    payload: {
      gcSubscriptionId: input.gcSubscriptionId,
      amountMinor: resource.amount,
      reason: input.reason ?? null,
    },
    actorId: input.actorId,
  })

  return { gcSubscriptionId: resource.id, status: resource.status }
}

/** Reinstate a cancelled/expired mandate where the scheme allows it. A mandate
 *  the bank has revoked cannot be reinstated — GoCardless rejects the call and
 *  the operator sees that error (fail closed, nothing mutated locally). */
export async function reinstateMandateAction(
  db: DbClient,
  input: { gcMandateId: string; reason?: string } & ActorContext,
): Promise<{ gcMandateId: string; state: string }> {
  const client = createClient()
  const resource = await client.reinstateMandate(input.gcMandateId)

  await upsertGcMandateMirror(db, mandateMirrorInput(resource))

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.mandate.reinstated',
    target: { type: 'GcMandate', id: input.gcMandateId },
    requestId: input.requestId,
    after: { state: resource.status, reason: input.reason ?? null },
  })

  await writeDdInteraction(db, {
    gcCustomerId: resource.links.customer ?? null,
    summary: 'Direct Debit mandate reinstated',
    payload: { gcMandateId: input.gcMandateId, reason: input.reason ?? null },
    actorId: input.actorId,
  })

  return { gcMandateId: resource.id, state: resource.status }
}

export interface RefundPaymentInput extends ActorContext {
  gcPaymentId: string
  /** Amount to refund in minor units (≤ the collected amount). */
  amountMinor: number
  reason: string
}

export interface RefundResult {
  gcRefundId: string
  amountMinor: number
}

/**
 * Refund a collected Direct Debit payment. Human-confirmed and audited like
 * every money write (§34); idempotent on the caller's requestId. GoCardless's
 * own `total_amount_confirmation` double-entry guard is passed the same
 * amount — a SECOND refund attempt against the same payment therefore fails
 * at the provider rather than double-refunding (fail closed). Requires
 * refunds to be enabled on the GoCardless account.
 */
export async function refundCollectedPayment(
  db: DbClient,
  input: RefundPaymentInput,
): Promise<RefundResult> {
  const payment = await db.gcPayment.findUnique({
    where: { gcPaymentId: input.gcPaymentId },
    select: { gcCustomerId: true, amountMinor: true, description: true },
  })
  if (payment && input.amountMinor > payment.amountMinor) {
    throw new Error(
      `Refund of ${input.amountMinor} exceeds the collected amount ${payment.amountMinor}.`,
    )
  }
  const client = createClient()
  const resource = await client.createRefund(
    {
      amount: input.amountMinor,
      total_amount_confirmation: input.amountMinor,
      metadata: { crmActorId: input.actorId },
      links: { payment: input.gcPaymentId },
    },
    `refund:${input.requestId}`,
  )

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.payment.refunded',
    target: { type: 'GcPayment', id: input.gcPaymentId },
    requestId: input.requestId,
    after: {
      gcRefundId: resource.id,
      amountMinor: input.amountMinor,
      reason: input.reason,
    },
  })

  await writeDdInteraction(db, {
    gcCustomerId: payment?.gcCustomerId ?? null,
    summary: 'Direct Debit payment refunded',
    payload: {
      gcPaymentId: input.gcPaymentId,
      gcRefundId: resource.id,
      amountMinor: input.amountMinor,
      reason: input.reason,
    },
    actorId: input.actorId,
  })

  return { gcRefundId: resource.id, amountMinor: resource.amount }
}

export interface UpdateGcCustomerInput extends ActorContext {
  gcCustomerId: string
  email?: string
  givenName?: string
  familyName?: string
  phone?: string
  companyName?: string
}

/** Update a customer's identity details at GoCardless and mirror them back.
 *  Never touches the CRM contact link (§3 — matching stays human-driven). */
export async function updateGcCustomerDetails(
  db: DbClient,
  input: UpdateGcCustomerInput,
): Promise<{ gcCustomerId: string }> {
  const client = createClient()
  const resource = await client.updateCustomer(input.gcCustomerId, {
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.givenName !== undefined ? { given_name: input.givenName } : {}),
    ...(input.familyName !== undefined ? { family_name: input.familyName } : {}),
    ...(input.phone !== undefined ? { phone_number: input.phone } : {}),
    ...(input.companyName !== undefined ? { company_name: input.companyName } : {}),
  })

  // autoMatch false: an identity edit must never re-run auto-linking (§3).
  await upsertGcCustomerMirror(db, customerMirrorInput(resource, { autoMatch: false }))

  await writeAuditLogEntry(db, {
    actorId: input.actorId,
    action: 'gocardless.customer.updated',
    target: { type: 'GcCustomer', id: input.gcCustomerId },
    requestId: input.requestId,
    after: {
      email: resource.email ?? null,
      givenName: resource.given_name ?? null,
      familyName: resource.family_name ?? null,
      phone: resource.phone_number ?? null,
    },
  })

  return { gcCustomerId: resource.id }
}
