// Outbound action tests (fake client + in-memory db). Cover the behaviours the
// parity work added: the payment-reference default on raise, the full field
// pass-through, payment_date on a recorded adjustment, and the reminder
// timestamp stamp. CLAUDE.md §3 (audited), ADR 0036.

import { describe, expect, it, vi } from 'vitest'

import type { InvoicingClient } from './client'
import { raiseInvoice, recordPayment, sendReminder } from './outbound'

interface Row {
  id: string
  [k: string]: unknown
}

function table() {
  const rows = new Map<string, Row>()
  return {
    rows,
    async findUnique({ where }: { where: { invoicingId?: string; id?: string }; select?: unknown }) {
      for (const r of rows.values()) {
        if (where.invoicingId !== undefined && r['invoicingId'] === where.invoicingId) return r
        if (where.id !== undefined && r.id === where.id) return r
      }
      return null
    },
    async findFirst() {
      return null
    },
    async findMany({ where }: { where?: { invoiceId?: string } } = {}) {
      return [...rows.values()].filter((r) => !where?.invoiceId || r['invoiceId'] === where.invoiceId)
    },
    async create({ data }: { data: Row; select?: unknown }) {
      rows.set(data.id, { ...data })
      return { ...data }
    },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const r = rows.get(where.id)
      if (r) Object.assign(r, data)
      return r
    },
    async updateMany({
      where,
      data,
    }: {
      where: { invoicingId?: string; deletedAt?: null }
      data: Record<string, unknown>
    }) {
      let count = 0
      for (const r of rows.values()) {
        if (where.invoicingId && r['invoicingId'] !== where.invoicingId) continue
        Object.assign(r, data)
        count += 1
      }
      return { count }
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
      for (const r of rows.values()) {
        if (r['invoicingId'] === where.invoicingId) {
          Object.assign(r, update)
          return r
        }
      }
      rows.set(create.id, { ...create })
      return { ...create }
    },
    async delete({ where }: { where: { id: string } }) {
      const r = rows.get(where.id)
      rows.delete(where.id)
      return r
    },
    async deleteMany() {
      return { count: 0 }
    },
  }
}

function makeDb() {
  return {
    invoicingInvoice: table(),
    invoicingLineItem: table(),
    invoicingPayment: table(),
    invoicingCustomer: table(),
    auditLogEntry: table(),
  }
}

type FakeClientCall = { method: string; args: unknown[] }

function makeFakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: FakeClientCall[] = []
  let created: Record<string, unknown> = {
    id: 'inv1',
    invoice_number: 'INV-1001',
    status: 'issued',
    partner_id: 'ptn1',
  }
  const client = {
    async createInvoice(payload: unknown) {
      calls.push({ method: 'createInvoice', args: [payload] })
      return created
    },
    async updateInvoice(id: string, patch: Record<string, unknown>) {
      calls.push({ method: 'updateInvoice', args: [id, patch] })
      created = { ...created, ...patch }
      return created
    },
    async getInvoice(id: string) {
      calls.push({ method: 'getInvoice', args: [id] })
      return created
    },
    async recordPayment(id: string, payload: unknown) {
      calls.push({ method: 'recordPayment', args: [id, payload] })
      return {}
    },
    async sendReminder(id: string, payload: unknown) {
      calls.push({ method: 'sendReminder', args: [id, payload] })
      return { sent: true, to: 'client@example.test', log_id: 'log1' }
    },
    ...overrides,
  }
  return { client: client as unknown as InvoicingClient, calls }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

describe('raiseInvoice', () => {
  it('defaults payment_reference to the invoice number without dashes', async () => {
    const { client, calls } = makeFakeClient()
    await raiseInvoice(makeDb() as never, {
      partnerId: 'ptn1',
      lineItems: [{ description: 'Tutoring', quantity: 1, unitPriceMinor: 5000, vatRate: 20 }],
      ctx,
      client,
    })
    const upd = calls.find((c) => c.method === 'updateInvoice')
    expect(upd).toBeTruthy()
    expect(upd?.args[1]).toEqual({ payment_reference: 'INV1001' })
  })

  it('does not override an explicitly-provided payment reference', async () => {
    const { client, calls } = makeFakeClient()
    await raiseInvoice(makeDb() as never, {
      partnerId: 'ptn1',
      lineItems: [{ description: 'Tutoring', quantity: 1, unitPriceMinor: 5000 }],
      paymentReference: 'CUSTOMREF',
      ctx,
      client,
    })
    expect(calls.find((c) => c.method === 'updateInvoice')).toBeUndefined()
    const create = calls.find((c) => c.method === 'createInvoice')
    expect((create?.args[0] as Record<string, unknown>)['payment_reference']).toBe('CUSTOMREF')
  })

  it('passes the full field set through to the platform', async () => {
    const { client, calls } = makeFakeClient()
    await raiseInvoice(makeDb() as never, {
      partnerId: 'ptn1',
      lineItems: [{ description: 'Tutoring', quantity: 1, unitPriceMinor: 5000, vatRate: 0 }],
      clientType: 'international',
      currency: 'GBP',
      pricesIncludeVat: false,
      issueDate: '2026-06-06',
      dueDate: '2026-07-06',
      billingCompanyId: 'bc1',
      bankAccountId: 'ba1',
      billToName: 'Acme Holdings Ltd',
      fromEmail: 'finance@studymind.co.uk',
      poNumber: 'PO-12345',
      paymentTerms: 'Payment due within 30 days',
      notes: 'Thank you.',
      internalNotes: 'Chase via finance only.',
      paymentReference: 'INV1042',
      ctx,
      client,
    })
    const payload = calls.find((c) => c.method === 'createInvoice')?.args[0] as Record<string, unknown>
    expect(payload).toMatchObject({
      partner_id: 'ptn1',
      client_type: 'international',
      prices_include_vat: false,
      issue_date: '2026-06-06',
      due_date: '2026-07-06',
      billing_company_id: 'bc1',
      bank_account_id: 'ba1',
      bill_to_name: 'Acme Holdings Ltd',
      from_email: 'finance@studymind.co.uk',
      po_number: 'PO-12345',
      payment_terms: 'Payment due within 30 days',
      internal_notes: 'Chase via finance only.',
      payment_reference: 'INV1042',
    })
    // International → every line VAT-free.
    const lines = payload['line_items'] as { vat_rate?: number }[]
    expect(lines[0]?.vat_rate).toBe(0)
  })
})

describe('recordPayment (adjustment)', () => {
  it('sends amount + payment_date + method + reference', async () => {
    const { client, calls } = makeFakeClient()
    await recordPayment(makeDb() as never, {
      invoicingId: 'inv1',
      amountMinor: 5000,
      paymentDate: '2026-06-06',
      method: 'other',
      reference: 'Discount – Referral',
      ctx,
      client,
    })
    const rp = calls.find((c) => c.method === 'recordPayment')
    expect(rp?.args[1]).toMatchObject({
      amount: 50,
      payment_date: '2026-06-06',
      method: 'other',
      reference: 'Discount – Referral',
    })
  })
})

describe('sendReminder', () => {
  it('stamps lastReminderAt on the mirrored invoice', async () => {
    const { client } = makeFakeClient()
    const db = makeDb()
    db.invoicingInvoice.rows.set('row1', {
      id: 'row1',
      invoicingId: 'inv1',
      lastReminderAt: null,
    })
    const before = Date.now()
    vi.useRealTimers()
    await sendReminder(db as never, { invoicingId: 'inv1', ctx, client })
    const row = db.invoicingInvoice.rows.get('row1')
    expect(row?.['lastReminderAt']).toBeInstanceOf(Date)
    expect((row?.['lastReminderAt'] as Date).getTime()).toBeGreaterThanOrEqual(before - 1000)
  })
})
