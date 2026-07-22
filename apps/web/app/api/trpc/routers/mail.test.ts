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
  /** Gmail label-mirror folder state (§14). Empty/absent → the legacy
   *  status-based fallback branch applies, mirroring an un-healed head. */
  gmailLabelIds?: string[]
  isStarred?: boolean
  isTrashed?: boolean
  tags?: string[]
  contact?: { id: string; firstName: string | null; lastName: string | null; email: string | null } | null
  mailAccount?: { address: string } | null
}

type Where = Record<string, unknown>

/** Read a row field, defaulting the label-mirror columns the way Postgres does
 *  (array columns default to [], booleans to false) so a fixture that omits them
 *  exercises the legacy fallback branch. */
function fieldValue(row: ConvRow, key: string): unknown {
  switch (key) {
    case 'gmailLabelIds':
      return row.gmailLabelIds ?? []
    case 'tags':
      return row.tags ?? []
    case 'isTrashed':
      return row.isTrashed ?? false
    case 'isStarred':
      return row.isStarred ?? false
    default:
      return (row as unknown as Record<string, unknown>)[key]
  }
}

function matchLeaf(value: unknown, cond: unknown): boolean {
  if (cond instanceof Date) {
    return value instanceof Date && value.getTime() === cond.getTime()
  }
  if (cond === null || typeof cond !== 'object') return value === cond
  const c = cond as Record<string, unknown>
  if ('gt' in c) return typeof value === 'number' && value > (c['gt'] as number)
  if ('lt' in c) {
    if (value instanceof Date && c['lt'] instanceof Date) {
      return value.getTime() < (c['lt'] as Date).getTime()
    }
    return (value as string | number) < (c['lt'] as string | number)
  }
  if ('has' in c) return Array.isArray(value) && value.includes(c['has'])
  if ('hasSome' in c)
    return Array.isArray(value) && (c['hasSome'] as unknown[]).some((x) => value.includes(x))
  if ('isEmpty' in c)
    return Array.isArray(value) ? (value.length === 0) === c['isEmpty'] : c['isEmpty'] === true
  if ('contains' in c)
    return (
      typeof value === 'string' &&
      value.toLowerCase().includes(String(c['contains']).toLowerCase())
    )
  if ('equals' in c) return value === c['equals']
  if ('not' in c) return value !== c['not']
  if ('in' in c) return Array.isArray(c['in']) && (c['in'] as unknown[]).includes(value)
  return false
}

/** Recursive Prisma-ish where evaluator — handles AND/OR/NOT + the leaf
 *  operators the mail folder queries use (has/hasSome/isEmpty/gt/lt/contains). */
function matchEmailWhere(row: ConvRow, where: Where): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue
    if (key === 'AND') {
      if (!(cond as Where[]).every((w) => matchEmailWhere(row, w))) return false
      continue
    }
    if (key === 'OR') {
      if (!(cond as Where[]).some((w) => matchEmailWhere(row, w))) return false
      continue
    }
    if (key === 'NOT') {
      if (matchEmailWhere(row, cond as Where)) return false
      continue
    }
    if (!matchLeaf(fieldValue(row, key), cond)) return false
  }
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

  // Default to a manager — these tests exercise folder/pagination logic, which
  // is role-agnostic; a manager sees every mailbox so the per-mailbox access
  // scope (tested separately in account-access.test.ts) doesn't filter them out.
  const user: SessionUser = { id: 'u_me', email: 'me@studymind.co.uk', role: opts.role ?? 'manager' }
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

  it('ignores a typed query — full search routes through Gmail (mail.search)', async () => {
    // The folder list is a fast keyset browse of synced heads; a typed query is
    // handled by mail.threads.search (Gmail `q`), not here, so list returns the
    // whole folder regardless of `q`.
    const ctx = makeCtx({
      conversations: [
        emailRow({ id: 'e1', subject: 'UCAT mock results', lastMessageAt: new Date('2026-05-31T11:00:00Z') }),
        emailRow({ id: 'e2', subject: 'Interview prep', lastMessageAt: new Date('2026-05-31T10:00:00Z') }),
      ],
    })
    const res = await mailRouter
      .createCaller(ctx)
      .threads.list({ filter: 'all', q: 'ucat', limit: 50 })
    expect(res.items.map((i) => i.id)).toEqual(['e1', 'e2'])
  })

  it('derives folders from the live Gmail label set (Spam / Sent / category tabs)', async () => {
    const ctx = makeCtx({
      conversations: [
        emailRow({ id: 'inbox', gmailLabelIds: ['INBOX', 'CATEGORY_PERSONAL'] }),
        emailRow({ id: 'promo', gmailLabelIds: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
        emailRow({ id: 'spam', gmailLabelIds: ['SPAM'] }),
        emailRow({ id: 'sent', gmailLabelIds: ['SENT'] }),
        emailRow({ id: 'trash', gmailLabelIds: ['TRASH'], isTrashed: true }),
      ],
    })
    const caller = mailRouter.createCaller(ctx)
    const ids = async (filter: Parameters<typeof caller.threads.list>[0]['filter']) =>
      (await caller.threads.list({ filter, limit: 50 })).items.map((i) => i.id).sort()

    // Primary tab = INBOX without a non-personal category (spam/sent/promo excluded).
    expect(await ids('primary')).toEqual(['inbox'])
    expect(await ids('promotions')).toEqual(['promo'])
    expect(await ids('spam')).toEqual(['spam'])
    expect(await ids('sent')).toEqual(['sent'])
    expect(await ids('trash')).toEqual(['trash'])
    // All Mail excludes Spam + Trash.
    expect(await ids('all')).toEqual(['inbox', 'promo', 'sent'])
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
