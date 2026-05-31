// mail router tests (ADR 0021 Phase 4). In-memory db fake; covers the staff
// gate and the email/account/unread filtering of the thread list.

import { describe, expect, it, vi } from 'vitest'

import type { AuditRecorder, SessionUser, TrpcContext, UserRole } from '@/lib/trpc/builders'

import { mailRouter } from './mail'

interface ConvRow {
  id: string
  provider: string | null
  mailAccountId: string | null
  contactId: string | null
  subject: string | null
  unreadCount: number
  status: string
  lastMessageAt: Date
  contact?: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null
  mailAccount?: { address: string } | null
}

type Where = Record<string, unknown>

function matchEmailWhere(row: ConvRow, where: Where): boolean {
  if (where['provider'] && row.provider !== where['provider']) return false
  if (where['mailAccountId'] && row.mailAccountId !== where['mailAccountId']) return false
  const unread = where['unreadCount'] as { gt?: number } | undefined
  if (unread && typeof unread.gt === 'number' && !(row.unreadCount > unread.gt)) return false
  return true
}

function makeCtx(opts: { role?: UserRole; conversations?: ConvRow[] }): TrpcContext {
  const conversations = opts.conversations ?? []
  const audit = vi.fn(async () => 'a') as unknown as AuditRecorder
  ;(audit as unknown as { called: boolean }).called = false

  const db = {
    mailAccountMember: { findMany: async () => [] },
    mailAccount: { findMany: async () => [] },
    conversation: {
      findMany: async ({ where, take }: { where: Where; take: number }) => {
        const rows = conversations
          .filter((r) => matchEmailWhere(r, where))
          .sort((a, b) => b.lastMessageAt.getTime() - a.lastMessageAt.getTime())
          .slice(0, take)
        return rows
      },
    },
  }

  const user: SessionUser = { id: 'u_me', email: 'me@studymind.co.uk', role: opts.role ?? 'sales_executive' }
  return {
    user,
    requestId: 'req_1',
    db: db as never,
    audit,
    headers: { origin: null, host: null },
  }
}

const emailRow = (over: Partial<ConvRow> & Pick<ConvRow, 'id'>): ConvRow => ({
  provider: 'email',
  mailAccountId: 'acc_1',
  contactId: 'c_1',
  subject: 'Re: UCAT',
  unreadCount: 0,
  status: 'open',
  lastMessageAt: new Date('2026-05-31T10:00:00Z'),
  contact: { id: 'c_1', firstName: 'Test', lastName: 'Parent', email: 'p@x.test' },
  mailAccount: { address: 'info@studymind.co.uk' },
  ...over,
})

describe('mail.threads.list', () => {
  it('returns only email heads, newest first', async () => {
    const ctx = makeCtx({
      conversations: [
        emailRow({ id: 'e1', lastMessageAt: new Date('2026-05-31T09:00:00Z') }),
        emailRow({ id: 'e2', lastMessageAt: new Date('2026-05-31T11:00:00Z') }),
        // a Trengo head must be excluded
        emailRow({ id: 't1', provider: 'trengo', mailAccountId: null }),
      ],
    })
    const res = await mailRouter.createCaller(ctx).threads.list({ filter: 'all', limit: 50 })
    expect(res.items.map((i) => i.id)).toEqual(['e2', 'e1'])
    expect(res.items[0]?.contactName).toBe('Test Parent')
    expect(res.items[0]?.accountAddress).toBe('info@studymind.co.uk')
  })

  it('filters to unread', async () => {
    const ctx = makeCtx({
      conversations: [
        emailRow({ id: 'e1', unreadCount: 0 }),
        emailRow({ id: 'e2', unreadCount: 3 }),
      ],
    })
    const res = await mailRouter.createCaller(ctx).threads.list({ filter: 'unread', limit: 50 })
    expect(res.items.map((i) => i.id)).toEqual(['e2'])
  })

  it('filters to a single account', async () => {
    const ctx = makeCtx({
      conversations: [
        emailRow({ id: 'e1', mailAccountId: 'acc_1' }),
        emailRow({ id: 'e2', mailAccountId: 'acc_2' }),
      ],
    })
    const res = await mailRouter
      .createCaller(ctx)
      .threads.list({ mailAccountId: 'acc_2', filter: 'all', limit: 50 })
    expect(res.items.map((i) => i.id)).toEqual(['e2'])
  })

  it('paginates with a cursor', async () => {
    const ctx = makeCtx({
      conversations: [emailRow({ id: 'e1' }), emailRow({ id: 'e2' })],
    })
    const res = await mailRouter.createCaller(ctx).threads.list({ filter: 'all', limit: 1 })
    expect(res.items).toHaveLength(1)
    expect(res.nextCursor).not.toBeNull()
  })
})
