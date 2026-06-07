// Inbound sync: apply an invoicing-platform record to our mirror tables.
//
// Every upsert dedupes on the invoicing-side id (`invoicingId`) so the three
// inbound channels (webhook, SSE, nightly events-feed) converge idempotently
// (CLAUDE.md §2). `record` is treated as the source of truth for the fields we
// mirror (CLAUDE.md task). Money lands in integer minor units (§19).
//
// These functions are I/O (they write Postgres) but contain no HTTP — the
// caller (jobs.ts) supplies the already-parsed record and the event source.

import { createId } from '@paralleldrive/cuid2'
import type { Prisma, PrismaClient } from '@prisma/client'

import {
  RawCustomer,
  RawInvoice,
  RawPayment,
  mapClientType,
  mapCustomerCategory,
  mapCustomerStatus,
  mapInvoiceStatus,
  toMinor,
  type EventSource,
} from './types'

export type DbClient = PrismaClient | Prisma.TransactionClient

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export interface UpsertResult {
  id: string
  created: boolean
}

/**
 * Upsert a mirror customer from a platform "partner" record. Correlation FKs
 * (businessAccountId / contactId) are preserved if already set — inbound
 * events never blow away a link the outbound lookup-or-create established.
 */
export async function upsertCustomerFromRecord(
  db: DbClient,
  record: unknown,
  source: EventSource,
): Promise<UpsertResult> {
  const parsed = RawCustomer.parse(record)
  const existing = await db.invoicingCustomer.findUnique({
    where: { invoicingId: parsed.id },
    select: { id: true },
  })

  const data = {
    category: mapCustomerCategory(parsed.category),
    status: mapCustomerStatus(parsed.status),
    companyName: parsed.company_name,
    contactName: parsed.contact_name ?? null,
    contactEmail: parsed.contact_email ?? null,
    contactEmailCc: parsed.contact_email_cc ?? null,
    phone: parsed.phone ?? null,
    address: parsed.address ?? null,
    country: parsed.country ?? null,
    vatNumber: parsed.vat_number ?? null,
    service: parsed.service ?? null,
    tags: parsed.tags ?? [],
    notes: parsed.notes ?? null,
    // A live record arriving as create/update means it is NOT deleted on the
    // platform (archived rows arrive as `deleted` events, never upserts). So
    // clear any prior soft-delete: this is how a platform restore (un-archive)
    // re-surfaces a customer that was previously deleted here.
    deletedAt: null,
    lastSyncedAt: new Date(),
    lastEventSource: source,
  }

  if (existing) {
    await db.invoicingCustomer.update({ where: { id: existing.id }, data })
    return { id: existing.id, created: false }
  }

  const created = await db.invoicingCustomer.create({
    data: { id: createId(), invoicingId: parsed.id, ...data },
    select: { id: true },
  })
  return { id: created.id, created: true }
}

/**
 * Upsert a mirror invoice (+ its line items and payments) from a platform
 * invoice record. Resolves the local customer FK from `partner_id` when we
 * already mirror that customer; otherwise leaves `customerId` null and keeps
 * the raw `invoicingPartnerId` so a later customer sync can backfill it.
 */
export async function upsertInvoiceFromRecord(
  db: DbClient,
  record: unknown,
  source: EventSource,
): Promise<UpsertResult> {
  const parsed = RawInvoice.parse(record)

  let customerId: string | null = null
  if (parsed.partner_id) {
    const cust = await db.invoicingCustomer.findUnique({
      where: { invoicingId: parsed.partner_id },
      select: { id: true },
    })
    customerId = cust?.id ?? null
  }

  const payments = parsed.payments ?? []
  const hasPaymentsArray = Array.isArray(parsed.payments)
  const paidFromRecord = payments.reduce((sum, p) => sum + toMinor(p.amount), 0)

  // paidMinor / outstanding are subtle. Inbound webhook/list/events records
  // carry the BARE invoice row — no `payments` array (payments live in a
  // separate table and arrive as their own payment.* events). Two rules keep
  // "outstanding" honest so a paid invoice never shows as still due:
  //   1. The platform `status` is authoritative — a `paid` invoice has nothing
  //      outstanding even before we have received its discrete payment rows.
  //   2. Never clobber an accumulated paidMinor back to 0 just because THIS
  //      record omitted the payments array — only trust the array when present;
  //      otherwise keep the total built up from payment.* events.
  const mappedStatus = mapInvoiceStatus(parsed.status)
  const grandTotalMinor = toMinor(parsed.grand_total)
  const resolvePaidMinor = (existingPaid: number): number => {
    if (mappedStatus === 'paid') return grandTotalMinor
    if (hasPaymentsArray) return paidFromRecord
    return existingPaid
  }

  const data = {
    invoiceNumber: parsed.invoice_number ?? null,
    customerId,
    invoicingPartnerId: parsed.partner_id ?? null,
    status: mappedStatus,
    clientType: mapClientType(parsed.client_type),
    currency: (parsed.currency ?? 'GBP').toUpperCase(),
    subtotalMinor: toMinor(parsed.subtotal),
    vatTotalMinor: toMinor(parsed.vat_total),
    grandTotalMinor,
    pricesIncludeVat: parsed.prices_include_vat ?? null,
    issueDate: parseDate(parsed.issue_date),
    dueDate: parseDate(parsed.due_date),
    paymentTerms: parsed.payment_terms ?? null,
    poNumber: parsed.po_number ?? null,
    paymentReference: parsed.payment_reference ?? null,
    billToName: parsed.bill_to_name ?? null,
    fromEmail: parsed.from_email ?? null,
    notes: parsed.notes ?? null,
    internalNotes: parsed.internal_notes ?? null,
    lastEmailedAt: parseDate(parsed.last_emailed_at),
    // See upsertCustomerFromRecord: a live upsert clears any prior soft-delete
    // so a platform restore (un-archive) re-surfaces the invoice here.
    deletedAt: null,
    lastSyncedAt: new Date(),
    lastEventSource: source,
  }

  const existing = await db.invoicingInvoice.findUnique({
    where: { invoicingId: parsed.id },
    select: { id: true, paidMinor: true },
  })

  let invoiceRowId: string
  let created: boolean
  if (existing) {
    await db.invoicingInvoice.update({
      where: { id: existing.id },
      data: { ...data, paidMinor: resolvePaidMinor((existing.paidMinor as number | undefined) ?? 0) },
    })
    invoiceRowId = existing.id
    created = false
  } else {
    const row = await db.invoicingInvoice.create({
      data: { id: createId(), invoicingId: parsed.id, ...data, paidMinor: resolvePaidMinor(0) },
      select: { id: true },
    })
    invoiceRowId = row.id
    created = true
  }

  // Line items: replace-by-position. The platform sends the full set, so we
  // upsert each on its deterministic invoicingId and drop any we no longer see.
  if (parsed.line_items) {
    const seen: string[] = []
    let position = 0
    for (const li of parsed.line_items) {
      const liId =
        li.id !== null && li.id !== undefined ? String(li.id) : `${parsed.id}:${position}`
      seen.push(liId)
      const liData = {
        invoiceId: invoiceRowId,
        description: li.description,
        quantity: String(li.quantity),
        unitPriceMinor: toMinor(li.unit_price),
        vatRate:
          li.vat_rate === null || li.vat_rate === undefined
            ? null
            : Math.round(Number(li.vat_rate)),
        position,
      }
      await db.invoicingLineItem.upsert({
        where: { invoicingId: liId },
        create: { id: createId(), invoicingId: liId, ...liData },
        update: liData,
      })
      position += 1
    }
    await db.invoicingLineItem.deleteMany({
      where: { invoiceId: invoiceRowId, invoicingId: { notIn: seen.length ? seen : ['__none__'] } },
    })
  }

  // Payments: idempotent on the platform payment id (no double-count).
  for (const p of payments) {
    await upsertPaymentRow(db, invoiceRowId, p, source)
  }

  return { id: invoiceRowId, created }
}

/** Upsert one payment row against an already-resolved local invoice. */
async function upsertPaymentRow(
  db: DbClient,
  invoiceRowId: string,
  payment: RawPayment,
  source: EventSource,
): Promise<void> {
  const payId = String(payment.id)
  const data = {
    invoiceId: invoiceRowId,
    amountMinor: toMinor(payment.amount),
    currency: (payment.currency ?? 'GBP').toUpperCase(),
    method: payment.method ?? null,
    reference: payment.reference ?? null,
    paidAt: parseDate(payment.paid_at ?? payment.created_at),
    lastEventSource: source,
  }
  await db.invoicingPayment.upsert({
    where: { invoicingId: payId },
    create: { id: createId(), invoicingId: payId, ...data },
    update: data,
  })
}

/**
 * Upsert a standalone payment record (from a `payment.*` event). Resolves the
 * local invoice from the event's invoice id; no-op if we don't mirror that
 * invoice yet (the invoice event will carry the payment when it syncs).
 */
export async function upsertPaymentFromRecord(
  db: DbClient,
  record: unknown,
  source: EventSource,
): Promise<{ id: string; created: boolean } | { skipped: true; reason: string }> {
  const obj = (record ?? {}) as Record<string, unknown>
  const rawInvoiceId =
    (obj['invoice_id'] as string | undefined) ?? (obj['invoiceId'] as string | undefined) ?? null
  if (!rawInvoiceId) return { skipped: true, reason: 'no_invoice_id' }

  const invoice = await db.invoicingInvoice.findUnique({
    where: { invoicingId: rawInvoiceId },
    select: { id: true, currency: true },
  })
  if (!invoice) return { skipped: true, reason: 'invoice_not_mirrored' }

  const parsed = RawPayment.parse(record)
  const payId = String(parsed.id)
  const before = await db.invoicingPayment.findUnique({
    where: { invoicingId: payId },
    select: { id: true },
  })
  await upsertPaymentRow(db, invoice.id, parsed, source)

  // Recompute the invoice's paidMinor from the full payment set so the mirror
  // stays consistent regardless of event ordering.
  await recomputeInvoicePaid(db, invoice.id)

  const after = await db.invoicingPayment.findUnique({
    where: { invoicingId: payId },
    select: { id: true },
  })
  return { id: after?.id ?? '', created: !before }
}

/**
 * Remove a mirrored payment by its invoicing-side id and recompute the parent
 * invoice's paid total. No-op if we never mirrored it. Used by the outbound
 * remove-payment flow and the inbound `payment.deleted` event so a payment
 * removed on either side disappears from the mirror (no stale row).
 */
export async function deletePaymentByInvoicingId(
  db: DbClient,
  paymentInvoicingId: string,
): Promise<{ deleted: boolean }> {
  const row = await db.invoicingPayment.findUnique({
    where: { invoicingId: paymentInvoicingId },
    select: { id: true, invoiceId: true },
  })
  if (!row) return { deleted: false }
  await db.invoicingPayment.delete({ where: { id: row.id } })
  await recomputeInvoicePaid(db, row.invoiceId)
  return { deleted: true }
}

/** Soft-delete a mirrored invoice (a human deleted it on the platform). We
 *  keep the row (CLAUDE.md soft-delete) but stamp `deletedAt` so it drops out
 *  of the CRM's lists. */
export async function softDeleteInvoiceByInvoicingId(
  db: DbClient,
  invoicingId: string,
): Promise<void> {
  await db.invoicingInvoice.updateMany({
    where: { invoicingId, deletedAt: null },
    data: { deletedAt: new Date(), lastSyncedAt: new Date() },
  })
}

/** Soft-delete a mirrored customer (a human deleted it on the platform). */
export async function softDeleteCustomerByInvoicingId(
  db: DbClient,
  invoicingId: string,
): Promise<void> {
  await db.invoicingCustomer.updateMany({
    where: { invoicingId, deletedAt: null },
    data: { deletedAt: new Date(), lastSyncedAt: new Date() },
  })
}

/** Sum payments → invoice.paidMinor. Cheap and order-independent. */
export async function recomputeInvoicePaid(db: DbClient, invoiceRowId: string): Promise<void> {
  const rows = await db.invoicingPayment.findMany({
    where: { invoiceId: invoiceRowId },
    select: { amountMinor: true },
  })
  const paidMinor = rows.reduce((sum: number, r: { amountMinor: number }) => sum + r.amountMinor, 0)
  await db.invoicingInvoice.update({
    where: { id: invoiceRowId },
    data: { paidMinor },
  })
}
