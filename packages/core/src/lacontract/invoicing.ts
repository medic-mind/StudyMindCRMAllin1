// LAInvoice flow. CLAUDE.md §43.2-§43.4.
//
// LA-billed Families do NOT use Stripe / GoCardless. Invoicing is manual:
// finance generates a draft from delivered hours, exports it out-of-band,
// captures the LA purchase order on send, and reconciles against the LA's
// payment manually.
//
// State machine:  draft → sent → paid (or disputed | written_off as terminal
// detours). Transitions are explicit; AP review overdue blocks invoicing
// for the affected learner-Family (§43.4).

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import { BusinessError } from '../errors'

type DbWriter = PrismaClient | Prisma.TransactionClient

export type LAInvoiceState = 'draft' | 'sent' | 'paid' | 'disputed' | 'written_off'

export interface ActorCtx {
  actorId: string
  requestId: string
}

export interface GenerateLAInvoiceInput {
  contractId: string
  familyId: string
  /** Inclusive period covered by this invoice. */
  periodStart: Date
  periodEnd: Date
  /** Hourly rate in minor units (pence). */
  ratePerHourMinor: number
  /** Optional explicit reference; otherwise generated. */
  reference?: string
}

export interface GenerateLAInvoiceResult {
  invoiceId: string
  amountMinor: number
  deliveredHours: number
  blockedReason?: 'ap_review_overdue'
}

interface ApPlacementRow {
  id: string
  apReviewDate: Date
  reviewStatus: string
}

async function fetchApPlacement(
  db: DbWriter,
  familyId: string,
): Promise<ApPlacementRow | null> {
  const apModel = (db as unknown as Record<string, unknown>)['aPPlacement']
  if (!apModel || typeof apModel !== 'object') return null
  return (
    (await (
      db as unknown as {
        aPPlacement: {
          findUnique: (args: unknown) => Promise<ApPlacementRow | null>
        }
      }
    ).aPPlacement.findUnique({
      where: { familyId },
      select: { id: true, apReviewDate: true, reviewStatus: true },
    })) ?? null
  )
}

/**
 * Generate a draft LAInvoice from delivered BookingSessions for a learner-
 * Family in the supplied period. Refuses to generate if the Family has an
 * AP placement with an overdue review (§43.4).
 */
export async function generateLAInvoice(
  db: DbWriter,
  input: GenerateLAInvoiceInput,
  ctx: ActorCtx,
): Promise<GenerateLAInvoiceResult> {
  // AP review overdue blocks invoicing per §43.4.
  const placement = await fetchApPlacement(db, input.familyId)
  if (
    placement &&
    placement.reviewStatus !== 'completed' &&
    placement.apReviewDate < new Date()
  ) {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `AP review overdue for family ${input.familyId}; cannot generate LAInvoice until review is completed`,
      { familyId: input.familyId, placementId: placement.id },
    )
  }

  // Sum delivered hours within the period for this Family.
  const sessions = (await db.bookingSession.findMany({
    where: {
      booking: { familyId: input.familyId, deletedAt: null },
      state: 'delivered',
      deletedAt: null,
    },
    select: { id: true, deliveredHours: true, scheduledAt: true },
  })) as Array<{ id: string; deliveredHours: number; scheduledAt: Date | null }>

  const inPeriod = sessions.filter((s) => {
    if (!s.scheduledAt) return false
    return s.scheduledAt >= input.periodStart && s.scheduledAt <= input.periodEnd
  })
  const deliveredHours = inPeriod.reduce((acc, s) => acc + (s.deliveredHours ?? 0), 0)
  const amountMinor = deliveredHours * input.ratePerHourMinor

  const invoiceId = createId()
  const reference = input.reference ?? `INV-${invoiceId.slice(0, 8).toUpperCase()}`

  await db.lAInvoice.create({
    data: {
      id: invoiceId,
      contractId: input.contractId,
      familyId: input.familyId,
      reference,
      state: 'draft',
      amountMinor,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      issuedAt: new Date(),
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'lacontract_invoice_generated',
      laContractId: input.contractId,
      familyId: input.familyId,
      occurredAt: new Date(),
      summary: `LAInvoice ${reference} generated`,
      payload: {
        event: 'lacontract.invoice_generated',
        invoiceId,
        reference,
        amountMinor,
        deliveredHours,
        periodStart: input.periodStart.toISOString(),
        periodEnd: input.periodEnd.toISOString(),
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.invoice_generated',
    target: { type: 'LAInvoice', id: invoiceId },
    requestId: ctx.requestId,
    after: {
      contractId: input.contractId,
      familyId: input.familyId,
      reference,
      amountMinor,
      deliveredHours,
    },
  })

  return { invoiceId, amountMinor, deliveredHours }
}

export interface MarkLAInvoiceSentInput {
  invoiceId: string
  sentAt: Date
  poNumber: string
}

export async function markLAInvoiceSent(
  db: DbWriter,
  input: MarkLAInvoiceSentInput,
  ctx: ActorCtx,
): Promise<void> {
  const invoice = await db.lAInvoice.findUniqueOrThrow({
    where: { id: input.invoiceId },
    select: { id: true, state: true, contractId: true, familyId: true, reference: true },
  })
  if (invoice.state !== 'draft') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Invoice ${input.invoiceId} is in state ${invoice.state}; only draft invoices can be marked sent`,
    )
  }

  await db.lAInvoice.update({
    where: { id: input.invoiceId },
    data: {
      state: 'sent',
      sentAt: input.sentAt,
      poNumber: input.poNumber,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'lacontract_invoice_sent',
      laContractId: invoice.contractId,
      familyId: invoice.familyId,
      occurredAt: input.sentAt,
      summary: `LAInvoice ${invoice.reference} sent (PO ${input.poNumber})`,
      payload: {
        event: 'lacontract.invoice_sent',
        invoiceId: invoice.id,
        poNumber: input.poNumber,
        sentAt: input.sentAt.toISOString(),
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.invoice_sent',
    target: { type: 'LAInvoice', id: input.invoiceId },
    requestId: ctx.requestId,
    before: { state: 'draft' },
    after: { state: 'sent', poNumber: input.poNumber },
  })
}

export interface MarkLAInvoicePaidInput {
  invoiceId: string
  paidAt: Date
  paymentReference: string
}

export async function markLAInvoicePaid(
  db: DbWriter,
  input: MarkLAInvoicePaidInput,
  ctx: ActorCtx,
): Promise<void> {
  const invoice = await db.lAInvoice.findUniqueOrThrow({
    where: { id: input.invoiceId },
    select: { id: true, state: true, contractId: true, familyId: true, reference: true },
  })
  if (invoice.state !== 'sent') {
    throw new BusinessError(
      'INVALID_STATE_TRANSITION',
      `Invoice ${input.invoiceId} is in state ${invoice.state}; only sent invoices can be marked paid`,
    )
  }

  await db.lAInvoice.update({
    where: { id: input.invoiceId },
    data: {
      state: 'paid',
      paidAt: input.paidAt,
      paymentReference: input.paymentReference,
      updatedById: ctx.actorId,
    },
  })

  await db.interaction.create({
    data: {
      id: createId(),
      type: 'lacontract_invoice_paid',
      laContractId: invoice.contractId,
      familyId: invoice.familyId,
      occurredAt: input.paidAt,
      summary: `LAInvoice ${invoice.reference} paid`,
      payload: {
        event: 'lacontract.invoice_paid',
        invoiceId: invoice.id,
        paymentReference: input.paymentReference,
        paidAt: input.paidAt.toISOString(),
      },
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
    },
  })

  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'lacontract.invoice_paid',
    target: { type: 'LAInvoice', id: input.invoiceId },
    requestId: ctx.requestId,
    before: { state: 'sent' },
    after: { state: 'paid', paymentReference: input.paymentReference },
  })
}
