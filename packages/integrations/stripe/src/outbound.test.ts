// Unit tests for the Stripe refund outbound. The Stripe SDK and Prisma
// client are stubbed; integration coverage lives under __tests__/integration/.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  StripePaymentNotFoundError,
  buildPaymentLinkIdempotencyKey,
  buildRefundIdempotencyKey,
  createPaymentLink,
  refundCharge,
} from './outbound'
import { __resetClientForTests } from './client'

interface FakePayment {
  id: string
  familyId: string
  amountMinor: number
  externalId: string
}

interface FakeIntent {
  id: string
  paymentId: string
  amountMinor: number
  reasonCode: string
  status: 'pending' | 'pending_review' | 'succeeded' | 'failed'
  idempotencyKey: string
  externalId: string | null
  createdById: string | null
  updatedById: string | null
}

interface FakeAudit {
  id: string
  action: string
  actorId: string | null
  targetType: string
  targetId: string
  requestId: string | null
  after: unknown
}

function makeFakeDb(payments: FakePayment[] = []) {
  const intents: FakeIntent[] = []
  const audits: FakeAudit[] = []
  let intentCounter = 0
  let auditCounter = 0

  const paymentFindUnique = vi.fn(async (args: { where: { externalId: string } }) => {
    return payments.find((p) => p.externalId === args.where.externalId) ?? null
  })

  const intentUpsert = vi.fn(
    async (args: {
      where: { idempotencyKey: string }
      create: Omit<FakeIntent, 'externalId'>
      update: Partial<FakeIntent>
    }) => {
      const existing = intents.find((i) => i.idempotencyKey === args.where.idempotencyKey)
      if (existing) {
        Object.assign(existing, args.update)
        return { ...existing }
      }
      intentCounter += 1
      const row: FakeIntent = {
        ...args.create,
        id: args.create.id ?? `ri_${intentCounter}`,
        externalId: null,
      }
      intents.push(row)
      return { ...row }
    },
  )

  const intentUpdate = vi.fn(
    async (args: { where: { id: string }; data: Partial<FakeIntent> }) => {
      const row = intents.find((i) => i.id === args.where.id)
      if (!row) throw new Error(`intent ${args.where.id} not found`)
      Object.assign(row, args.data)
      return { ...row }
    },
  )

  const auditFindFirst = vi.fn(async () => null)
  const auditCreate = vi.fn(async (args: { data: FakeAudit }) => {
    auditCounter += 1
    const row = { ...args.data, id: args.data.id ?? `al_${auditCounter}` }
    audits.push(row)
    return row
  })

  return {
    intents,
    audits,
    paymentFindUnique,
    intentUpsert,
    intentUpdate,
    auditCreate,
    db: {
      payment: { findUnique: paymentFindUnique },
      refundIntent: { upsert: intentUpsert, update: intentUpdate },
      auditLogEntry: { findFirst: auditFindFirst, create: auditCreate },
    } as unknown as Parameters<typeof refundCharge>[0],
  }
}

const refundsCreate = vi.fn()
const paymentLinksCreate = vi.fn()
vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      refunds = { create: refundsCreate }
      paymentLinks = { create: paymentLinksCreate }
      // Surface the constructor so client.ts can call `new Stripe(...)`.
      constructor(_apiKey: string, _opts: unknown) {}
    },
  }
})

const ORIGINAL_KEY = process.env['STRIPE_SECRET_KEY']

beforeEach(() => {
  process.env['STRIPE_SECRET_KEY'] = 'sk_test_dummy'
  __resetClientForTests()
  refundsCreate.mockReset()
  paymentLinksCreate.mockReset()
})

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env['STRIPE_SECRET_KEY']
  } else {
    process.env['STRIPE_SECRET_KEY'] = ORIGINAL_KEY
  }
})

describe('buildRefundIdempotencyKey', () => {
  it('formats as refund:<chargeId>:<reasonCode>', () => {
    expect(buildRefundIdempotencyKey('ch_123', 'duplicate')).toBe('refund:ch_123:duplicate')
  })
})

describe('refundCharge', () => {
  const payment: FakePayment = {
    id: 'pay_1',
    familyId: 'fam_1',
    amountMinor: 5000,
    externalId: 'ch_test_1',
  }

  it('creates the intent BEFORE calling Stripe and passes the idempotency key through', async () => {
    const fake = makeFakeDb([payment])
    const order: string[] = []

    fake.intentUpsert.mockImplementationOnce(async (args: Parameters<typeof fake.intentUpsert>[0]) => {
      order.push('intent.upsert')
      const row: FakeIntent = {
        ...args.create,
        id: 'ri_1',
        externalId: null,
      }
      fake.intents.push(row)
      return { ...row }
    })

    refundsCreate.mockImplementationOnce(async (_params: unknown, opts: { idempotencyKey: string }) => {
      order.push(`stripe.refunds.create(${opts.idempotencyKey})`)
      return { id: 're_test_1' }
    })

    const result = await refundCharge(fake.db, {
      chargeId: 'ch_test_1',
      reasonCode: 'duplicate',
      actorId: 'user_1',
      requestId: 'req_1',
    })

    expect(order).toEqual([
      'intent.upsert',
      'stripe.refunds.create(refund:ch_test_1:duplicate)',
    ])
    expect(refundsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        charge: 'ch_test_1',
        metadata: expect.objectContaining({ familyId: 'fam_1', actorId: 'user_1' }),
      }),
      { idempotencyKey: 'refund:ch_test_1:duplicate' },
    )
    expect(result.status).toBe('succeeded')
    expect(result.stripeRefundId).toBe('re_test_1')
  })

  it('writes an AuditLogEntry on success', async () => {
    const fake = makeFakeDb([payment])
    refundsCreate.mockResolvedValueOnce({ id: 're_test_2' })

    await refundCharge(fake.db, {
      chargeId: 'ch_test_1',
      reasonCode: 'fraudulent',
      actorId: 'user_2',
      requestId: 'req_2',
    })

    expect(fake.auditCreate).toHaveBeenCalledTimes(1)
    expect(fake.audits[0]?.action).toBe('charge.refunded')
    expect(fake.audits[0]?.targetType).toBe('Family')
    expect(fake.audits[0]?.targetId).toBe('fam_1')
    expect(fake.audits[0]?.requestId).toBe('req_2')
  })

  it('leaves the intent pending_review when Stripe fails and does not audit', async () => {
    const fake = makeFakeDb([payment])
    refundsCreate.mockRejectedValueOnce(new Error('card_declined'))

    await expect(
      refundCharge(fake.db, {
        chargeId: 'ch_test_1',
        reasonCode: 'requested_by_customer',
        actorId: 'user_3',
        requestId: 'req_3',
      }),
    ).rejects.toThrow('card_declined')

    expect(fake.intents).toHaveLength(1)
    expect(fake.intents[0]?.status).toBe('pending_review')
    expect(fake.auditCreate).not.toHaveBeenCalled()
  })

  it('throws StripePaymentNotFoundError when the charge is not mirrored', async () => {
    const fake = makeFakeDb([])

    await expect(
      refundCharge(fake.db, {
        chargeId: 'ch_missing',
        reasonCode: 'duplicate',
        actorId: 'user_4',
        requestId: 'req_4',
      }),
    ).rejects.toBeInstanceOf(StripePaymentNotFoundError)

    expect(refundsCreate).not.toHaveBeenCalled()
  })

  it('returns the existing succeeded intent on replay (no second Stripe call)', async () => {
    const fake = makeFakeDb([payment])
    refundsCreate.mockResolvedValueOnce({ id: 're_test_replay' })

    const first = await refundCharge(fake.db, {
      chargeId: 'ch_test_1',
      reasonCode: 'duplicate',
      actorId: 'user_5',
      requestId: 'req_5a',
    })
    const second = await refundCharge(fake.db, {
      chargeId: 'ch_test_1',
      reasonCode: 'duplicate',
      actorId: 'user_5',
      requestId: 'req_5b',
    })

    expect(first.refundIntentId).toBe(second.refundIntentId)
    expect(first.stripeRefundId).toBe(second.stripeRefundId)
    expect(refundsCreate).toHaveBeenCalledTimes(1)
  })
})

interface FakePaymentLinkIntent {
  id: string
  familyId: string
  contactId: string | null
  agentId: string
  amountMinor: number
  currency: string
  reason: string
  stripePaymentLinkId: string | null
  url: string | null
  status: 'pending' | 'created' | 'completed' | 'expired' | 'cancelled'
}

function makePaymentLinkDb() {
  const rows: FakePaymentLinkIntent[] = []
  const audits: FakeAudit[] = []
  let auditCounter = 0

  const create = vi.fn(async (args: { data: Omit<FakePaymentLinkIntent, 'stripePaymentLinkId' | 'url'> }) => {
    const row: FakePaymentLinkIntent = {
      ...args.data,
      contactId: args.data.contactId ?? null,
      stripePaymentLinkId: null,
      url: null,
    }
    rows.push(row)
    return { id: row.id }
  })

  const update = vi.fn(async (args: { where: { id: string }; data: Partial<FakePaymentLinkIntent> }) => {
    const row = rows.find((r) => r.id === args.where.id)
    if (!row) throw new Error(`payment link intent ${args.where.id} not found`)
    Object.assign(row, args.data)
    return { ...row }
  })

  const auditCreate = vi.fn(async (args: { data: FakeAudit }) => {
    auditCounter += 1
    const row = { ...args.data, id: args.data.id ?? `al_${auditCounter}` }
    audits.push(row)
    return row
  })

  return {
    rows,
    audits,
    create,
    update,
    auditCreate,
    db: {
      paymentLinkIntent: { create, update },
      auditLogEntry: { findFirst: vi.fn(async () => null), create: auditCreate },
    } as unknown as Parameters<typeof createPaymentLink>[0],
  }
}

describe('createPaymentLink', () => {
  it('formats idempotency key as payment_link:<intentId>', () => {
    expect(buildPaymentLinkIdempotencyKey('intent_abc')).toBe('payment_link:intent_abc')
  })

  it('persists intent BEFORE the Stripe call and forwards the metadata', async () => {
    const fake = makePaymentLinkDb()
    const order: string[] = []
    fake.create.mockImplementationOnce(async (args: Parameters<typeof fake.create>[0]) => {
      order.push('intent.create')
      const row: FakePaymentLinkIntent = {
        ...args.data,
        contactId: args.data.contactId ?? null,
        stripePaymentLinkId: null,
        url: null,
      }
      fake.rows.push(row)
      return { id: row.id }
    })
    paymentLinksCreate.mockImplementationOnce(async (params: { metadata: Record<string, string> }, opts: { idempotencyKey: string }) => {
      order.push(`stripe.paymentLinks.create(${opts.idempotencyKey})`)
      return { id: 'plink_test', url: 'https://buy.stripe.com/test_abc' }
    })

    const result = await createPaymentLink(fake.db, {
      familyId: 'fam_1',
      contactId: 'ctc_1',
      agentId: 'user_1',
      amountMinor: 5000,
      reason: 'one_off_session',
      productName: 'Trial session',
      requestId: 'req_pl_1',
    })

    expect(order[0]).toBe('intent.create')
    expect(order[1]).toMatch(/^stripe\.paymentLinks\.create\(payment_link:/)
    expect(paymentLinksCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          familyId: 'fam_1',
          contactId: 'ctc_1',
          agentId: 'user_1',
          reason: 'one_off_session',
        }),
      }),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^payment_link:/) }),
    )
    expect(result.url).toBe('https://buy.stripe.com/test_abc')
    expect(result.stripePaymentLinkId).toBe('plink_test')
    expect(fake.rows[0]?.status).toBe('created')
  })

  it('writes a charge.payment_link_created audit row on success', async () => {
    const fake = makePaymentLinkDb()
    paymentLinksCreate.mockResolvedValueOnce({ id: 'plink_2', url: 'https://buy.stripe.com/test_2' })

    await createPaymentLink(fake.db, {
      familyId: 'fam_2',
      agentId: 'user_2',
      amountMinor: 10000,
      reason: 'topup',
      productName: 'Top up',
      requestId: 'req_pl_2',
    })

    expect(fake.auditCreate).toHaveBeenCalledTimes(1)
    expect(fake.audits[0]?.action).toBe('charge.payment_link_created')
    expect(fake.audits[0]?.targetType).toBe('Family')
    expect(fake.audits[0]?.targetId).toBe('fam_2')
  })

  it('rejects non-positive amounts', async () => {
    const fake = makePaymentLinkDb()
    await expect(
      createPaymentLink(fake.db, {
        familyId: 'fam_x',
        agentId: 'user_x',
        amountMinor: 0,
        reason: 'bad',
        productName: 'Bad',
        requestId: 'req_x',
      }),
    ).rejects.toThrow(/positive/)
    expect(paymentLinksCreate).not.toHaveBeenCalled()
  })
})
