// Finance refund tRPC tests. CLAUDE.md §8 (Stripe), §27 (tRPC), §20 (RBAC).
//
// Stripe SDK is stubbed via createClient mock; we exercise the tRPC slice and
// trust the underlying refundCharge logic (covered by outbound.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AuditRecorder,
  SessionUser,
  TrpcContext,
  UserRole,
} from '@/lib/trpc/builders'

vi.mock('@studymind/integration-stripe/client', async () => {
  return {
    createClient: () => ({
      refunds: {
        create: vi.fn(async (params: { charge: string }) => ({
          id: `re_${params.charge}`,
        })),
      },
    }),
    __resetClientForTests: () => {},
  }
})

import { financeRouter } from './finance'

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
  createdAt: Date
  deletedAt: Date | null
  payment: FakePayment
}

function makeCtx(role: UserRole = 'manager', payments: FakePayment[] = []): {
  ctx: TrpcContext
  intents: FakeIntent[]
  audit: ReturnType<typeof vi.fn>
} {
  const intents: FakeIntent[] = []
  let counter = 0

  const db = {
    payment: {
      findUnique: ({ where }: { where: { externalId: string } }) =>
        Promise.resolve(payments.find((p) => p.externalId === where.externalId) ?? null),
    },
    refundIntent: {
      upsert: ({
        where,
        create,
      }: {
        where: { idempotencyKey: string }
        create: Omit<FakeIntent, 'createdAt' | 'externalId' | 'deletedAt' | 'payment'> & {
          paymentId: string
        }
      }) => {
        const existing = intents.find((i) => i.idempotencyKey === where.idempotencyKey)
        if (existing) {
          return Promise.resolve({
            id: existing.id,
            status: existing.status,
            externalId: existing.externalId,
          })
        }
        const payment = payments.find((p) => p.id === create.paymentId)!
        const row: FakeIntent = {
          id: `ri_${++counter}`,
          paymentId: create.paymentId,
          amountMinor: create.amountMinor,
          reasonCode: create.reasonCode,
          status: 'pending',
          idempotencyKey: create.idempotencyKey,
          externalId: null,
          createdAt: new Date(`2026-05-${10 + counter}T10:00:00Z`),
          deletedAt: null,
          payment,
        }
        intents.push(row)
        return Promise.resolve({ id: row.id, status: row.status, externalId: row.externalId })
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string }
        data: Partial<FakeIntent>
      }) => {
        const row = intents.find((i) => i.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return Promise.resolve(row)
      },
      findMany: () => Promise.resolve([...intents].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())),
    },
    auditLogEntry: {
      create: vi.fn(async (args: { data: { id?: string } }) => ({ id: args.data.id ?? 'a_1' })),
      findFirst: vi.fn(async () => null),
    },
  }

  const audit = vi.fn(async (_input: unknown) => 'audit_1')
  const wrapped: AuditRecorder = (async (input) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const user: SessionUser = {
    id: 'u_1',
    email: 'me@example.com',
    role,
  }
  const ctx: TrpcContext = {
    user,
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, intents, audit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('finance.refund.create', () => {
  it('refunds a known charge and audits the call', async () => {
    const payment: FakePayment = {
      id: 'pay_1',
      familyId: 'fam_1',
      amountMinor: 5000,
      externalId: 'ch_abc',
    }
    const { ctx, intents, audit } = makeCtx('manager', [payment])
    const caller = financeRouter.createCaller(ctx)

    const result = await caller.refund.create({
      chargeId: 'ch_abc',
      reasonCode: 'duplicate',
    })

    expect(result.status).toBe('succeeded')
    expect(result.stripeRefundId).toBe('re_ch_abc')
    expect(intents).toHaveLength(1)
    expect(intents[0]!.status).toBe('succeeded')
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'charge.refund_requested',
      }),
    )
  })

  it('is idempotent on retry — second call returns the same refund id', async () => {
    const payment: FakePayment = {
      id: 'pay_1',
      familyId: 'fam_1',
      amountMinor: 5000,
      externalId: 'ch_abc',
    }
    const { ctx } = makeCtx('manager', [payment])
    const caller = financeRouter.createCaller(ctx)

    const first = await caller.refund.create({ chargeId: 'ch_abc', reasonCode: 'duplicate' })
    const second = await caller.refund.create({ chargeId: 'ch_abc', reasonCode: 'duplicate' })

    expect(first.refundIntentId).toBe(second.refundIntentId)
    expect(second.status).toBe('succeeded')
  })

  it('allows sales_executive and virtual_assistant to issue refunds (2026-07)', async () => {
    for (const role of ['sales_executive', 'virtual_assistant'] as const) {
      const payment: FakePayment = {
        id: 'pay_1',
        familyId: 'fam_1',
        amountMinor: 5000,
        externalId: 'ch_abc',
      }
      const { ctx } = makeCtx(role, [payment])
      const caller = financeRouter.createCaller(ctx)
      const result = await caller.refund.create({ chargeId: 'ch_abc', reasonCode: 'duplicate' })
      expect(result.status).toBe('succeeded')
    }
  })

  it('returns NOT_FOUND for an unknown charge', async () => {
    const { ctx } = makeCtx('manager', [])
    const caller = financeRouter.createCaller(ctx)

    await expect(
      caller.refund.create({ chargeId: 'ch_unknown', reasonCode: 'duplicate' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('finance.refund.list', () => {
  it('returns refund intents scoped to the requested family', async () => {
    const payment: FakePayment = {
      id: 'pay_1',
      familyId: 'fam_1',
      amountMinor: 5000,
      externalId: 'ch_abc',
    }
    const { ctx } = makeCtx('manager', [payment])
    const caller = financeRouter.createCaller(ctx)
    await caller.refund.create({ chargeId: 'ch_abc', reasonCode: 'duplicate' })

    const list = await caller.refund.list({ limit: 10 })
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({
      chargeId: 'ch_abc',
      reasonCode: 'duplicate',
      status: 'succeeded',
    })
  })

  it('allows sales_executive and virtual_assistant to read refund intents (2026-07)', async () => {
    for (const role of ['sales_executive', 'virtual_assistant'] as const) {
      const payment: FakePayment = {
        id: 'pay_1',
        familyId: 'fam_1',
        amountMinor: 5000,
        externalId: 'ch_abc',
      }
      const { ctx } = makeCtx(role, [payment])
      const caller = financeRouter.createCaller(ctx)
      await caller.refund.create({ chargeId: 'ch_abc', reasonCode: 'duplicate' })
      const list = await caller.refund.list({ limit: 10 })
      expect(list.items).toHaveLength(1)
    }
  })
})
