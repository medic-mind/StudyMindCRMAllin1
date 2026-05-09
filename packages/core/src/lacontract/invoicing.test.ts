import { describe, expect, it } from 'vitest'

import { BusinessError } from '../errors'
import {
  generateLAInvoice,
  markLAInvoicePaid,
  markLAInvoiceSent,
} from './invoicing'

interface FakeRow {
  id: string
  [k: string]: unknown
}

function makeFakeDb(opts: {
  apReviewOverdue?: boolean
  sessions?: Array<{ id: string; deliveredHours: number; scheduledAt: Date }>
}) {
  const placement: FakeRow | null = opts.apReviewOverdue
    ? {
        id: 'ap_1',
        familyId: 'f1',
        apReviewDate: new Date(Date.now() - 86_400_000),
        reviewStatus: 'pending',
      }
    : null
  const sessions = opts.sessions ?? []
  const invoices: FakeRow[] = []
  const interactions: FakeRow[] = []
  const auditEntries: FakeRow[] = []

  const db = {
    aPPlacement: {
      findUnique: ({ where }: { where: { familyId: string } }) =>
        Promise.resolve(placement && placement['familyId'] === where.familyId ? placement : null),
    },
    bookingSession: {
      findMany: () =>
        Promise.resolve(sessions.map((s) => ({ ...s, scheduledAt: s.scheduledAt }))),
    },
    lAInvoice: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        invoices.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const i = invoices.find((row) => row.id === where.id)
        if (!i) return Promise.reject(new Error('not found'))
        return Promise.resolve(i)
      },
      update: ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const i = invoices.find((row) => row.id === where.id)!
        Object.assign(i, data)
        return Promise.resolve(i)
      },
    },
    interaction: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        interactions.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
    auditLogEntry: {
      findFirst: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        auditEntries.push({ ...data } as FakeRow)
        return Promise.resolve({ id: data['id'] })
      },
    },
  }

  return { db: db as never, invoices, interactions, auditEntries }
}

const ACTOR = { actorId: 'user_1', requestId: 'req_1' }

describe('generateLAInvoice', () => {
  it('sums delivered hours in the period and creates a draft invoice', async () => {
    const fake = makeFakeDb({
      sessions: [
        {
          id: 's1',
          deliveredHours: 3,
          scheduledAt: new Date('2026-04-10'),
        },
        {
          id: 's2',
          deliveredHours: 2,
          scheduledAt: new Date('2026-04-15'),
        },
        {
          id: 's3',
          deliveredHours: 4,
          scheduledAt: new Date('2026-05-15'),
        },
      ],
    })
    const r = await generateLAInvoice(
      fake.db,
      {
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        ratePerHourMinor: 5_000,
      },
      ACTOR,
    )
    expect(r.deliveredHours).toBe(5)
    expect(r.amountMinor).toBe(25_000)
    expect(fake.invoices[0]?.['state']).toBe('draft')
    expect(fake.auditEntries[0]?.['action']).toBe('lacontract.invoice_generated')
  })

  it('refuses to generate when AP review is overdue', async () => {
    const fake = makeFakeDb({ apReviewOverdue: true })
    await expect(
      generateLAInvoice(
        fake.db,
        {
          contractId: 'c1',
          familyId: 'f1',
          periodStart: new Date('2026-04-01'),
          periodEnd: new Date('2026-04-30'),
          ratePerHourMinor: 5_000,
        },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('markLAInvoiceSent', () => {
  it('moves draft → sent and records the PO number', async () => {
    const fake = makeFakeDb({ sessions: [] })
    const { invoiceId } = await generateLAInvoice(
      fake.db,
      {
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        ratePerHourMinor: 5_000,
      },
      ACTOR,
    )
    await markLAInvoiceSent(
      fake.db,
      { invoiceId, sentAt: new Date('2026-05-01'), poNumber: 'PO-123' },
      ACTOR,
    )
    expect(fake.invoices[0]?.['state']).toBe('sent')
    expect(fake.invoices[0]?.['poNumber']).toBe('PO-123')
  })

  it('rejects sending an already-sent invoice', async () => {
    const fake = makeFakeDb({ sessions: [] })
    const { invoiceId } = await generateLAInvoice(
      fake.db,
      {
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        ratePerHourMinor: 5_000,
      },
      ACTOR,
    )
    await markLAInvoiceSent(
      fake.db,
      { invoiceId, sentAt: new Date(), poNumber: 'PO-123' },
      ACTOR,
    )
    await expect(
      markLAInvoiceSent(
        fake.db,
        { invoiceId, sentAt: new Date(), poNumber: 'PO-456' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})

describe('markLAInvoicePaid', () => {
  it('moves sent → paid', async () => {
    const fake = makeFakeDb({ sessions: [] })
    const { invoiceId } = await generateLAInvoice(
      fake.db,
      {
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        ratePerHourMinor: 5_000,
      },
      ACTOR,
    )
    await markLAInvoiceSent(
      fake.db,
      { invoiceId, sentAt: new Date(), poNumber: 'PO' },
      ACTOR,
    )
    await markLAInvoicePaid(
      fake.db,
      { invoiceId, paidAt: new Date(), paymentReference: 'BACS-999' },
      ACTOR,
    )
    expect(fake.invoices[0]?.['state']).toBe('paid')
  })

  it('refuses to mark a draft as paid', async () => {
    const fake = makeFakeDb({ sessions: [] })
    const { invoiceId } = await generateLAInvoice(
      fake.db,
      {
        contractId: 'c1',
        familyId: 'f1',
        periodStart: new Date('2026-04-01'),
        periodEnd: new Date('2026-04-30'),
        ratePerHourMinor: 5_000,
      },
      ACTOR,
    )
    await expect(
      markLAInvoicePaid(
        fake.db,
        { invoiceId, paidAt: new Date(), paymentReference: 'B' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BusinessError)
  })
})
