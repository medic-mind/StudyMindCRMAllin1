// Outbound writes: CRM → invoicing platform. CLAUDE.md §3 (humans confirm,
// no silent mutation), §7 (idempotency), §20 (audit every financial write).
//
// Flow contract:
//   - lookup-or-create the customer, caching the returned invoicing id on the
//     CRM correlation row so the two sides stay linked.
//   - raise the invoice with line items; persist returned id + invoice_number.
//   - send / record-payment / mark-paid act on an already-mirrored invoice.
//
// Every write re-syncs the platform's response into our mirror tables via
// sync.ts (source 'api') so the local view is correct immediately, before the
// echo webhook arrives. The inbound path skips source==='api' to avoid a loop.

import type { Prisma, PrismaClient } from '@prisma/client'

import { writeAuditLogEntry } from '@studymind/audit'

import {
  businessAccountToCustomerPayload,
  contactToCustomerPayload,
  lineItemToPayload,
  type CrmBusinessAccount,
  type CrmContact,
  type CrmLineItem,
} from './adapter'
import { createClientFromConfig, type InvoiceWritePayload, type InvoicingClient } from './client'
import { upsertCustomerFromRecord, upsertInvoiceFromRecord, type DbClient } from './sync'

export interface OutboundContext {
  actorId: string
  requestId: string
}

type FullDb = PrismaClient | Prisma.TransactionClient

// -----------------------------------------------------------------------------
// Customer lookup-or-create.
// -----------------------------------------------------------------------------

export interface EnsureCustomerForAccountInput {
  businessAccountId: string
  account: CrmBusinessAccount
  ctx: OutboundContext
  client?: InvoicingClient
}

export interface EnsureCustomerResult {
  invoicingCustomerRowId: string
  invoicingId: string
  created: boolean
}

/**
 * Ensure a BusinessAccount has a customer on the platform. If we already mirror
 * one for this account, reuse it (and patch its fields); otherwise create it.
 * The returned invoicing id is cached on the InvoicingCustomer row, correlated
 * back to the BusinessAccount.
 */
export async function ensureCustomerForBusinessAccount(
  db: FullDb,
  input: EnsureCustomerForAccountInput,
): Promise<EnsureCustomerResult> {
  const client = input.client ?? (await createClientFromConfig())
  const payload = businessAccountToCustomerPayload(input.account)

  const existing = await db.invoicingCustomer.findFirst({
    where: { businessAccountId: input.businessAccountId, deletedAt: null },
    select: { id: true, invoicingId: true },
  })

  if (existing) {
    const updated = await client.updateCustomer(existing.invoicingId, payload)
    await upsertCustomerFromRecord(db, updated, 'api')
    await db.invoicingCustomer.update({
      where: { id: existing.id },
      data: { businessAccountId: input.businessAccountId, updatedById: input.ctx.actorId },
    })
    await auditCustomerPushed(db, existing.invoicingId, input.ctx, {
      businessAccountId: input.businessAccountId,
      created: false,
    })
    return {
      invoicingCustomerRowId: existing.id,
      invoicingId: existing.invoicingId,
      created: false,
    }
  }

  const created = await client.createCustomer(payload)
  const upserted = await upsertCustomerFromRecord(db, created, 'api')
  await db.invoicingCustomer.update({
    where: { id: upserted.id },
    data: {
      businessAccountId: input.businessAccountId,
      createdById: input.ctx.actorId,
      updatedById: input.ctx.actorId,
    },
  })
  await auditCustomerPushed(db, created.id, input.ctx, {
    businessAccountId: input.businessAccountId,
    created: true,
  })
  return { invoicingCustomerRowId: upserted.id, invoicingId: created.id, created: true }
}

export interface EnsureCustomerForContactInput {
  contactId: string
  contact: CrmContact
  ctx: OutboundContext
  client?: InvoicingClient
}

/** Ensure a B2C Contact has a customer on the platform (category 'b2c'). */
export async function ensureCustomerForContact(
  db: FullDb,
  input: EnsureCustomerForContactInput,
): Promise<EnsureCustomerResult> {
  const client = input.client ?? (await createClientFromConfig())
  const payload = contactToCustomerPayload(input.contact)

  const existing = await db.invoicingCustomer.findFirst({
    where: { contactId: input.contactId, deletedAt: null },
    select: { id: true, invoicingId: true },
  })

  if (existing) {
    const updated = await client.updateCustomer(existing.invoicingId, payload)
    await upsertCustomerFromRecord(db, updated, 'api')
    await auditCustomerPushed(db, existing.invoicingId, input.ctx, {
      contactId: input.contactId,
      created: false,
    })
    return {
      invoicingCustomerRowId: existing.id,
      invoicingId: existing.invoicingId,
      created: false,
    }
  }

  const created = await client.createCustomer(payload)
  const upserted = await upsertCustomerFromRecord(db, created, 'api')
  await db.invoicingCustomer.update({
    where: { id: upserted.id },
    data: {
      contactId: input.contactId,
      createdById: input.ctx.actorId,
      updatedById: input.ctx.actorId,
    },
  })
  await auditCustomerPushed(db, created.id, input.ctx, {
    contactId: input.contactId,
    created: true,
  })
  return { invoicingCustomerRowId: upserted.id, invoicingId: created.id, created: true }
}

async function auditCustomerPushed(
  db: DbClient,
  invoicingId: string,
  ctx: OutboundContext,
  meta: Record<string, unknown>,
): Promise<void> {
  await writeAuditLogEntry(db, {
    actorId: ctx.actorId,
    action: 'invoicing.customer_pushed',
    target: { type: 'InvoicingCustomer', id: invoicingId },
    requestId: ctx.requestId,
    after: { invoicingId, ...meta },
  })
}

// -----------------------------------------------------------------------------
// Raise invoice.
// -----------------------------------------------------------------------------

export interface RaiseInvoiceInput {
  /** Invoicing-side partner id (from ensureCustomer*). */
  partnerId: string
  lineItems: CrmLineItem[]
  currency?: string
  clientType?: InvoiceWritePayload['client_type']
  pricesIncludeVat?: boolean
  dueDate?: string
  poNumber?: string
  notes?: string
  /** Pass 'draft' to keep it a draft; omit to auto-issue (platform default). */
  status?: InvoiceWritePayload['status']
  ctx: OutboundContext
  client?: InvoicingClient
}

export interface RaiseInvoiceResult {
  invoicingInvoiceRowId: string
  invoicingId: string
  invoiceNumber: string | null
}

/** Create an invoice with line items and mirror the response. */
export async function raiseInvoice(
  db: FullDb,
  input: RaiseInvoiceInput,
): Promise<RaiseInvoiceResult> {
  const client = input.client ?? (await createClientFromConfig())

  const payload: InvoiceWritePayload = {
    partner_id: input.partnerId,
    line_items: input.lineItems.map(lineItemToPayload),
    ...(input.currency ? { currency: input.currency } : {}),
    ...(input.clientType ? { client_type: input.clientType } : {}),
    ...(input.pricesIncludeVat !== undefined ? { prices_include_vat: input.pricesIncludeVat } : {}),
    ...(input.dueDate ? { due_date: input.dueDate } : {}),
    ...(input.poNumber ? { po_number: input.poNumber } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.status ? { status: input.status } : {}),
  }

  const created = await client.createInvoice(payload)
  const upserted = await upsertInvoiceFromRecord(db, created, 'api')

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'invoicing.invoice_raised',
    target: { type: 'InvoicingInvoice', id: created.id },
    requestId: input.ctx.requestId,
    after: {
      invoicingId: created.id,
      invoiceNumber: created.invoice_number ?? null,
      partnerId: input.partnerId,
      lineItemCount: input.lineItems.length,
      status: created.status ?? null,
    },
  })

  return {
    invoicingInvoiceRowId: upserted.id,
    invoicingId: created.id,
    invoiceNumber: created.invoice_number ?? null,
  }
}

// -----------------------------------------------------------------------------
// Send invoice (renders PDF + emails server-side).
// -----------------------------------------------------------------------------

export interface SendInvoiceInput {
  invoicingId: string
  to?: string
  cc?: string
  subject?: string
  body?: string
  fromEmail?: string
  fromName?: string
  ctx: OutboundContext
  client?: InvoicingClient
}

export interface SendInvoiceOutboundResult {
  sent: boolean
  to: string
  attachedPdf: boolean
  messageId: string
}

export async function sendInvoice(
  db: FullDb,
  input: SendInvoiceInput,
): Promise<SendInvoiceOutboundResult> {
  const client = input.client ?? (await createClientFromConfig())
  const res = await client.sendInvoice(input.invoicingId, {
    ...(input.to ? { to: input.to } : {}),
    ...(input.cc ? { cc: input.cc } : {}),
    ...(input.subject ? { subject: input.subject } : {}),
    ...(input.body ? { body: input.body } : {}),
    ...(input.fromEmail ? { from_email: input.fromEmail } : {}),
    ...(input.fromName ? { from_name: input.fromName } : {}),
  })

  await db.invoicingInvoice.updateMany({
    where: { invoicingId: input.invoicingId },
    data: { lastEmailedAt: new Date() },
  })

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'invoicing.invoice_sent',
    target: { type: 'InvoicingInvoice', id: input.invoicingId },
    requestId: input.ctx.requestId,
    after: { invoicingId: input.invoicingId, to: res.to, messageId: res.message_id },
  })

  return {
    sent: res.sent,
    to: res.to,
    attachedPdf: res.attached_pdf,
    messageId: res.message_id,
  }
}

// -----------------------------------------------------------------------------
// Record payment + mark paid.
// -----------------------------------------------------------------------------

export interface RecordPaymentInput {
  invoicingId: string
  amountMinor: number
  method?: string
  reference?: string
  ctx: OutboundContext
  client?: InvoicingClient
}

export async function recordPayment(db: FullDb, input: RecordPaymentInput): Promise<void> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error('amountMinor must be a positive integer (minor units)')
  }
  const client = input.client ?? (await createClientFromConfig())
  // The platform takes a major-unit amount; convert without float maths.
  const amount = Math.round(input.amountMinor) / 100
  await client.recordPayment(input.invoicingId, {
    amount,
    ...(input.method ? { method: input.method } : {}),
    ...(input.reference ? { reference: input.reference } : {}),
  })

  // Refetch the canonical invoice so the mirror (incl. payments[] + status)
  // reflects the platform's truth, not our optimistic guess (CLAUDE.md §8).
  const fresh = await client.getInvoice(input.invoicingId)
  await upsertInvoiceFromRecord(db, fresh, 'api')

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'invoicing.payment_recorded',
    target: { type: 'InvoicingInvoice', id: input.invoicingId },
    requestId: input.ctx.requestId,
    after: {
      invoicingId: input.invoicingId,
      amountMinor: input.amountMinor,
      method: input.method ?? null,
      reference: input.reference ?? null,
    },
  })
}

export interface MarkPaidInput {
  invoicingId: string
  ctx: OutboundContext
  client?: InvoicingClient
}

export async function markPaid(db: FullDb, input: MarkPaidInput): Promise<void> {
  const client = input.client ?? (await createClientFromConfig())
  const updated = await client.markPaid(input.invoicingId)
  await upsertInvoiceFromRecord(db, updated, 'api')

  await writeAuditLogEntry(db, {
    actorId: input.ctx.actorId,
    action: 'invoicing.invoice_marked_paid',
    target: { type: 'InvoicingInvoice', id: input.invoicingId },
    requestId: input.ctx.requestId,
    after: { invoicingId: input.invoicingId, status: updated.status ?? null },
  })
}
