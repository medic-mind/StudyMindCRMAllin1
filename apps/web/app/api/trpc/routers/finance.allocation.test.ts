// Finance allocation tRPC tests. CLAUDE.md §6.3, §41.2 (sum invariant), §27.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  AuditRecorder,
  SessionUser,
  TrpcContext,
  UserRole,
} from '@/lib/trpc/builders'

import { financeRouter } from './finance'

interface FakeAllocation {
  id: string
  paymentId: string
  bookingId: string
  amountMinor: number
  reason: string | null
  deletedAt: Date | null
  createdAt: Date
}

function makeCtx(
  role: UserRole = 'manager',
  payment: { id: string; amountMinor: number; familyId: string } | null = null,
  initial: FakeAllocation[] = [],
): {
  ctx: TrpcContext
  rows: FakeAllocation[]
  audit: ReturnType<typeof vi.fn>
} {
  const rows: FakeAllocation[] = [...initial]
  let counter = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db: any = {
    payment: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(payment && payment.id === where.id ? payment : null),
    },
    allocation: {
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(rows.find((r) => r.id === where.id) ?? null),
      findMany: ({ where }: { where: { paymentId: string; deletedAt: null } }) =>
        Promise.resolve(
          rows.filter((r) => r.paymentId === where.paymentId && r.deletedAt === null),
        ),
      create: ({ data }: { data: Omit<FakeAllocation, 'createdAt' | 'deletedAt'> & { createdById?: string; updatedById?: string } }) => {
        counter += 1
        const row: FakeAllocation = {
          id: data.id,
          paymentId: data.paymentId,
          bookingId: data.bookingId,
          amountMinor: data.amountMinor,
          reason: data.reason ?? null,
          deletedAt: null,
          createdAt: new Date(`2026-05-10T10:0${counter}:00Z`),
        }
        rows.push(row)
        return Promise.resolve(row)
      },
      update: ({ where, data }: { where: { id: string }; data: Partial<FakeAllocation> }) => {
        const row = rows.find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return Promise.resolve(row)
      },
    },
    auditLogEntry: {
      create: vi.fn(async (args: { data: { id?: string } }) => ({ id: args.data.id ?? 'a_1' })),
      findFirst: vi.fn(async () => null),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $transaction: async <T,>(fn: (tx: any) => Promise<T>): Promise<T> => fn(db),
  }

  const audit = vi.fn(async (_input: unknown) => 'audit_1')
  const wrapped: AuditRecorder = (async (input) => {
    ;(wrapped as unknown as { called: boolean }).called = true
    return audit(input)
  }) as AuditRecorder
  ;(wrapped as unknown as { called: boolean }).called = false

  const user: SessionUser = { id: 'u_1', email: 'me@example.com', role }
  const ctx: TrpcContext = {
    user,
    requestId: 'req_1',
    db: db as never,
    audit: wrapped,
    headers: { origin: null, host: null },
  }
  return { ctx, rows, audit }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('finance.allocation.upsert', () => {
  it('rejects allocations whose sum exceeds the Payment amount', async () => {
    const { ctx } = makeCtx('manager', { id: 'pay_1', amountMinor: 5000, familyId: 'fam_1' })
    const caller = financeRouter.createCaller(ctx)

    await expect(
      caller.allocation.upsert({
        paymentId: 'pay_1',
        allocations: [
          { bookingId: 'b_1', amountMinor: 3000, reason: 'session 1' },
          { bookingId: 'b_2', amountMinor: 3000, reason: 'session 2' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })

  it('creates new active rows and audits', async () => {
    const { ctx, rows, audit } = makeCtx('manager', {
      id: 'pay_1',
      amountMinor: 10000,
      familyId: 'fam_1',
    })
    const caller = financeRouter.createCaller(ctx)

    const result = await caller.allocation.upsert({
      paymentId: 'pay_1',
      allocations: [
        { bookingId: 'b_1', amountMinor: 4000, reason: 'session 1' },
        { bookingId: 'b_2', amountMinor: 6000, reason: 'session 2' },
      ],
    })

    expect(result.items).toHaveLength(2)
    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(2)
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'finance.allocation_upserted' }),
    )
  })

  it('is idempotent on (paymentId, bookingId) — second upsert updates in place', async () => {
    const initial: FakeAllocation = {
      id: 'a_1',
      paymentId: 'pay_1',
      bookingId: 'b_1',
      amountMinor: 3000,
      reason: 'first try',
      deletedAt: null,
      createdAt: new Date('2026-05-09T10:00:00Z'),
    }
    const { ctx, rows } = makeCtx('manager', { id: 'pay_1', amountMinor: 10000, familyId: 'fam_1' }, [initial])
    const caller = financeRouter.createCaller(ctx)

    await caller.allocation.upsert({
      paymentId: 'pay_1',
      allocations: [{ bookingId: 'b_1', amountMinor: 4000, reason: 'corrected' }],
    })

    expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1)
    expect(rows[0]?.amountMinor).toBe(4000)
    expect(rows[0]?.reason).toBe('corrected')
  })

  it('soft-deletes existing rows that are not in the incoming set', async () => {
    const initial: FakeAllocation[] = [
      {
        id: 'a_1',
        paymentId: 'pay_1',
        bookingId: 'b_1',
        amountMinor: 3000,
        reason: 'old',
        deletedAt: null,
        createdAt: new Date('2026-05-09T10:00:00Z'),
      },
      {
        id: 'a_2',
        paymentId: 'pay_1',
        bookingId: 'b_2',
        amountMinor: 2000,
        reason: 'old2',
        deletedAt: null,
        createdAt: new Date('2026-05-09T10:01:00Z'),
      },
    ]
    const { ctx, rows } = makeCtx('manager', { id: 'pay_1', amountMinor: 10000, familyId: 'fam_1' }, initial)
    const caller = financeRouter.createCaller(ctx)

    await caller.allocation.upsert({
      paymentId: 'pay_1',
      allocations: [{ bookingId: 'b_1', amountMinor: 3000, reason: 'kept' }],
    })

    expect(rows.find((r) => r.id === 'a_2')?.deletedAt).not.toBeNull()
    expect(rows.find((r) => r.id === 'a_1')?.deletedAt).toBeNull()
  })

  it('allows every staff role — finance ops opened to VA and above (2026-07)', async () => {
    for (const role of ['sales_executive', 'virtual_assistant'] as const) {
      const { ctx, rows } = makeCtx(role, { id: 'pay_1', amountMinor: 5000, familyId: 'fam_1' })
      const caller = financeRouter.createCaller(ctx)

      const result = await caller.allocation.upsert({
        paymentId: 'pay_1',
        allocations: [{ bookingId: 'b_1', amountMinor: 1000, reason: 'session 1' }],
      })
      expect(result.items).toHaveLength(1)
      expect(rows.filter((r) => r.deletedAt === null)).toHaveLength(1)
    }
  })
})

describe('finance.allocation.delete', () => {
  it('soft-deletes and audits', async () => {
    const initial: FakeAllocation = {
      id: 'a_1',
      paymentId: 'pay_1',
      bookingId: 'b_1',
      amountMinor: 3000,
      reason: 'old',
      deletedAt: null,
      createdAt: new Date('2026-05-09T10:00:00Z'),
    }
    const { ctx, rows, audit } = makeCtx('manager', { id: 'pay_1', amountMinor: 10000, familyId: 'fam_1' }, [initial])
    const caller = financeRouter.createCaller(ctx)

    await caller.allocation.delete({ allocationId: 'a_1' })
    expect(rows[0]?.deletedAt).not.toBeNull()
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'finance.allocation_deleted' }),
    )
  })

  it('returns NOT_FOUND on already-deleted row', async () => {
    const initial: FakeAllocation = {
      id: 'a_1',
      paymentId: 'pay_1',
      bookingId: 'b_1',
      amountMinor: 3000,
      reason: 'old',
      deletedAt: new Date('2026-05-09T10:00:00Z'),
      createdAt: new Date('2026-05-09T10:00:00Z'),
    }
    const { ctx } = makeCtx('manager', { id: 'pay_1', amountMinor: 10000, familyId: 'fam_1' }, [initial])
    const caller = financeRouter.createCaller(ctx)
    await expect(
      caller.allocation.delete({ allocationId: 'a_1' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
