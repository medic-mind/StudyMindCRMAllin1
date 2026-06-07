// Invoicing inbound-sync integration test. Exercises the idempotent mirror
// upserts against a tiny in-memory DB fake — no Postgres needed — to prove the
// acceptance criteria:
//   - a customer/invoice arriving twice produces ONE row (dedup on invoicingId)
//   - a payment that arrives via the invoice AND a standalone event is counted
//     ONCE (dedup on the platform payment id) — no double-payment
//   - invoice.paidMinor is recomputed from the payment set, order-independent.
//
// CLAUDE.md §2 (idempotency), §19 (minor units), §23 (integration tests).

import { describe, expect, it } from 'vitest'

import {
  deletePaymentByInvoicingId,
  softDeleteCustomerByInvoicingId,
  softDeleteInvoiceByInvoicingId,
  upsertCustomerFromRecord,
  upsertInvoiceFromRecord,
  upsertPaymentFromRecord,
  type DbClient,
} from '@studymind/integration-invoicing/sync'

// --- Minimal in-memory Prisma-shaped fake -----------------------------------
// Only the methods sync.ts touches are implemented. Each "table" is a Map
// keyed by row id with a secondary lookup by invoicingId.

interface Row {
  id: string
  invoicingId: string
  [k: string]: unknown
}

function makeTable() {
  const byId = new Map<string, Row>()
  return {
    byId,
    async findUnique({
      where,
      select,
    }: {
      where: { invoicingId?: string; id?: string }
      select?: unknown
    }) {
      void select
      for (const row of byId.values()) {
        if (where.invoicingId && row.invoicingId === where.invoicingId) return row
        if (where.id && row.id === where.id) return row
      }
      return null
    },
    async findMany({
      where,
    }: { where?: { invoiceId?: string; invoicingId?: { notIn?: string[] } } } = {}) {
      const out: Row[] = []
      for (const row of byId.values()) {
        if (where?.invoiceId && row['invoiceId'] !== where.invoiceId) continue
        out.push(row)
      }
      return out
    },
    async create({ data }: { data: Row; select?: unknown }) {
      const row = { ...data }
      byId.set(row.id, row)
      return row
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = byId.get(where.id)
      if (!row) throw new Error(`no row ${where.id}`)
      Object.assign(row, data)
      return row
    },
    async upsert({
      where,
      create,
      update,
    }: {
      where: { invoicingId: string }
      create: Row
      update: Record<string, unknown>
    }) {
      for (const row of byId.values()) {
        if (row.invoicingId === where.invoicingId) {
          Object.assign(row, update)
          return row
        }
      }
      const row = { ...create }
      byId.set(row.id, row)
      return row
    },
    async deleteMany({
      where,
    }: {
      where: { invoiceId: string; invoicingId?: { notIn?: string[] } }
    }) {
      const keep = where.invoicingId?.notIn ?? []
      for (const [id, row] of byId.entries()) {
        if (row['invoiceId'] === where.invoiceId && !keep.includes(row.invoicingId)) {
          byId.delete(id)
        }
      }
      return { count: 0 }
    },
    async delete({ where }: { where: { id: string } }) {
      const row = byId.get(where.id)
      byId.delete(where.id)
      return row ?? null
    },
    async updateMany({
      where,
      data,
    }: {
      where: { invoicingId?: string; deletedAt?: null }
      data: Record<string, unknown>
    }) {
      let count = 0
      for (const row of byId.values()) {
        if (where.invoicingId && row.invoicingId !== where.invoicingId) continue
        if (where.deletedAt === null && row['deletedAt'] != null) continue
        Object.assign(row, data)
        count += 1
      }
      return { count }
    },
  }
}

function makeDb() {
  return {
    invoicingCustomer: makeTable(),
    invoicingInvoice: makeTable(),
    invoicingLineItem: makeTable(),
    invoicingPayment: makeTable(),
  }
}

type FakeDb = ReturnType<typeof makeDb>

function asDb(db: FakeDb): DbClient {
  return db as unknown as DbClient
}

describe('invoicing inbound sync (idempotent mirror)', () => {
  it('dedups a customer arriving twice on invoicingId', async () => {
    const db = makeDb()
    const record = { id: 'ptn_1', company_name: 'Oakwood', category: 'b2b', status: 'active' }

    const first = await upsertCustomerFromRecord(asDb(db), record, 'app')
    const second = await upsertCustomerFromRecord(
      asDb(db),
      { ...record, phone: '+44 7000 000001' },
      'app',
    )

    expect(first.created).toBe(true)
    expect(second.created).toBe(false)
    expect(db.invoicingCustomer.byId.size).toBe(1)
    const row = [...db.invoicingCustomer.byId.values()][0]
    expect(row['companyName']).toBe('Oakwood')
    expect(row['phone']).toBe('+44 7000 000001') // record is source of truth
  })

  it('mirrors an invoice with line items + payments in minor units', async () => {
    const db = makeDb()
    const record = {
      id: 'inv_1',
      invoice_number: 'INV-1000',
      partner_id: 'ptn_1',
      status: 'issued',
      currency: 'GBP',
      subtotal: '600.00',
      vat_total: '120.00',
      grand_total: '720.00',
      line_items: [
        {
          id: 'li_1',
          description: 'UCAT — 10 sessions',
          quantity: 10,
          unit_price: 50,
          vat_rate: 20,
        },
        { id: 'li_2', description: 'Materials', quantity: 1, unit_price: 100, vat_rate: 20 },
      ],
      payments: [{ id: 'pay_1', amount: '200.00', method: 'bank_transfer' }],
    }

    await upsertInvoiceFromRecord(asDb(db), record, 'app')

    const inv = [...db.invoicingInvoice.byId.values()][0]
    expect(inv['subtotalMinor']).toBe(60000)
    expect(inv['vatTotalMinor']).toBe(12000)
    expect(inv['grandTotalMinor']).toBe(72000)
    expect(inv['paidMinor']).toBe(20000)
    expect(db.invoicingLineItem.byId.size).toBe(2)
    expect(db.invoicingPayment.byId.size).toBe(1)
  })

  it('does not double-count a payment seen via the invoice and a standalone event', async () => {
    const db = makeDb()
    // Invoice arrives first, carrying payment pay_1 (£200).
    await upsertInvoiceFromRecord(
      asDb(db),
      {
        id: 'inv_1',
        partner_id: 'ptn_1',
        status: 'partially_paid',
        grand_total: '720.00',
        payments: [{ id: 'pay_1', amount: '200.00' }],
      },
      'app',
    )
    expect(db.invoicingPayment.byId.size).toBe(1)

    // The SAME payment then arrives again as a standalone payment.created event.
    const result = await upsertPaymentFromRecord(
      asDb(db),
      { id: 'pay_1', invoice_id: 'inv_1', amount: '200.00' },
      'app',
    )

    // Still one payment row; paidMinor unchanged at £200.
    expect(db.invoicingPayment.byId.size).toBe(1)
    if ('skipped' in result) throw new Error('should not have skipped')
    expect(result.created).toBe(false)
    const inv = [...db.invoicingInvoice.byId.values()][0]
    expect(inv['paidMinor']).toBe(20000)
  })

  it('skips a standalone payment whose invoice is not yet mirrored', async () => {
    const db = makeDb()
    const result = await upsertPaymentFromRecord(
      asDb(db),
      { id: 'pay_99', invoice_id: 'inv_unknown', amount: '50.00' },
      'app',
    )
    expect(result).toEqual({ skipped: true, reason: 'invoice_not_mirrored' })
    expect(db.invoicingPayment.byId.size).toBe(0)
  })

  it('removes a payment and recomputes paidMinor (remove-payment / payment.deleted)', async () => {
    const db = makeDb()
    await upsertInvoiceFromRecord(
      asDb(db),
      {
        id: 'inv_1',
        partner_id: 'ptn_1',
        status: 'partially_paid',
        grand_total: '720.00',
        payments: [
          { id: 'pay_1', amount: '200.00' },
          { id: 'pay_2', amount: '100.00' },
        ],
      },
      'app',
    )
    expect(db.invoicingPayment.byId.size).toBe(2)

    const removed = await deletePaymentByInvoicingId(asDb(db), 'pay_1')
    expect(removed).toEqual({ deleted: true })
    expect(db.invoicingPayment.byId.size).toBe(1)
    const inv = [...db.invoicingInvoice.byId.values()][0]
    expect(inv['paidMinor']).toBe(10000) // only pay_2 (£100) remains

    // Removing one we never mirrored is a no-op.
    const noop = await deletePaymentByInvoicingId(asDb(db), 'pay_missing')
    expect(noop).toEqual({ deleted: false })
  })

  it('soft-deletes a mirrored invoice on a platform delete', async () => {
    const db = makeDb()
    await upsertInvoiceFromRecord(
      asDb(db),
      { id: 'inv_1', partner_id: 'ptn_1', status: 'issued', grand_total: '100.00' },
      'app',
    )
    await softDeleteInvoiceByInvoicingId(asDb(db), 'inv_1')
    const inv = [...db.invoicingInvoice.byId.values()][0]
    expect(inv['deletedAt']).not.toBeNull()
  })

  it('re-surfaces a soft-deleted invoice when it is restored on the platform', async () => {
    const db = makeDb()
    const record = { id: 'inv_1', partner_id: 'ptn_1', status: 'issued', grand_total: '100.00' }
    await upsertInvoiceFromRecord(asDb(db), record, 'app')
    // Platform delete (archive) → soft-deleted here.
    await softDeleteInvoiceByInvoicingId(asDb(db), 'inv_1')
    expect([...db.invoicingInvoice.byId.values()][0]['deletedAt']).not.toBeNull()

    // Platform restore (un-archive) arrives as a normal create/update event.
    await upsertInvoiceFromRecord(asDb(db), record, 'app')

    expect(db.invoicingInvoice.byId.size).toBe(1) // still one row, not a duplicate
    expect([...db.invoicingInvoice.byId.values()][0]['deletedAt']).toBeNull()
  })

  it('re-surfaces a soft-deleted customer when it is restored on the platform', async () => {
    const db = makeDb()
    const record = { id: 'ptn_1', company_name: 'Oakwood', category: 'b2b', status: 'active' }
    await upsertCustomerFromRecord(asDb(db), record, 'app')
    await softDeleteCustomerByInvoicingId(asDb(db), 'ptn_1')
    expect([...db.invoicingCustomer.byId.values()][0]['deletedAt']).not.toBeNull()

    await upsertCustomerFromRecord(asDb(db), record, 'app')

    expect(db.invoicingCustomer.byId.size).toBe(1)
    expect([...db.invoicingCustomer.byId.values()][0]['deletedAt']).toBeNull()
  })

  it('shows nothing outstanding when the platform marks the invoice paid (no payments array)', async () => {
    const db = makeDb()
    // A bare invoice.updated record (status=paid) — webhook/events records carry
    // the invoice row with NO payments[] (payments are a separate table).
    await upsertInvoiceFromRecord(
      asDb(db),
      { id: 'inv_1', partner_id: 'ptn_1', status: 'paid', grand_total: '720.00' },
      'app',
    )
    const inv = [...db.invoicingInvoice.byId.values()][0]
    expect(inv['grandTotalMinor']).toBe(72000)
    expect(inv['paidMinor']).toBe(72000) // outstanding = 0
  })

  it('does not reset an accumulated paidMinor when a payments-less update arrives', async () => {
    const db = makeDb()
    // Invoice first arrives carrying a £200 payment (partially paid).
    await upsertInvoiceFromRecord(
      asDb(db),
      {
        id: 'inv_1',
        partner_id: 'ptn_1',
        status: 'partially_paid',
        grand_total: '720.00',
        payments: [{ id: 'pay_1', amount: '200.00' }],
      },
      'app',
    )
    expect([...db.invoicingInvoice.byId.values()][0]['paidMinor']).toBe(20000)

    // A later bare update (e.g. "reminder sent") with NO payments array must NOT
    // clobber the £200 back to zero.
    await upsertInvoiceFromRecord(
      asDb(db),
      { id: 'inv_1', partner_id: 'ptn_1', status: 'partially_paid', grand_total: '720.00' },
      'app',
    )
    expect([...db.invoicingInvoice.byId.values()][0]['paidMinor']).toBe(20000)
  })
})
