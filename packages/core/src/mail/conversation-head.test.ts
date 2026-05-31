// applyMailToConversation tests (ADR 0021 Phase 3b). In-memory conversation
// store; verifies create, monotonic merges, unread tracking, and idempotency.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyMailToConversation,
  type ApplyMailInput,
  type MailConversationDb,
  type MailConversationRow,
} from './conversation-head'

vi.mock('../realtime', () => ({ publishConversationUpdate: vi.fn() }))

function makeDb(): { db: MailConversationDb; rows: MailConversationRow[] } {
  const rows: MailConversationRow[] = []
  const db: MailConversationDb = {
    conversation: {
      findFirst: async ({ where }) =>
        rows.find(
          (r) =>
            r.provider === where.provider && r.externalThreadId === where.externalThreadId,
        ) ?? null,
      create: async ({ data }) => {
        const row = { ...data } as unknown as MailConversationRow
        rows.push(row)
        return row
      },
      update: async ({ where, data }) => {
        const row = rows.find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        Object.assign(row, data)
        return row
      },
    },
  }
  return { db, rows }
}

const base: ApplyMailInput = {
  provider: 'email',
  externalThreadId: 'thread_1',
  mailAccountId: 'acc_1',
  direction: 'received',
  occurredAt: new Date('2026-05-31T10:00:00Z'),
  contactId: 'c_1',
  familyId: null,
  subject: 'Re: UCAT tutoring',
}

beforeEach(() => vi.clearAllMocks())

describe('applyMailToConversation', () => {
  it('creates an email head on first sight', async () => {
    const { db, rows } = makeDb()
    const row = await applyMailToConversation(db, base)
    expect(rows).toHaveLength(1)
    expect(row.provider).toBe('email')
    expect(row.channel).toBe('email')
    expect(row.externalThreadId).toBe('thread_1')
    expect(row.unreadCount).toBe(1)
    expect(row.lastInboundAt).toEqual(base.occurredAt)
    expect(row.contactId).toBe('c_1')
  })

  it('is idempotent — re-applying the same message is a no-op', async () => {
    const { db, rows } = makeDb()
    await applyMailToConversation(db, base)
    const again = await applyMailToConversation(db, base)
    expect(rows).toHaveLength(1)
    expect(again.unreadCount).toBe(1) // not double-counted
  })

  it('increments unread on a newer inbound, advances the clock', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base)
    const row = await applyMailToConversation(db, {
      ...base,
      occurredAt: new Date('2026-05-31T11:00:00Z'),
    })
    expect(row.unreadCount).toBe(2)
    expect(row.lastMessageAt).toEqual(new Date('2026-05-31T11:00:00Z'))
  })

  it('resets unread to 0 on outbound', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base)
    const row = await applyMailToConversation(db, {
      ...base,
      direction: 'sent',
      occurredAt: new Date('2026-05-31T12:00:00Z'),
    })
    expect(row.unreadCount).toBe(0)
    expect(row.lastOutboundAt).toEqual(new Date('2026-05-31T12:00:00Z'))
  })

  it('does not bump unread for a stale inbound that pre-dates the last outbound', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base) // inbound @10:00, unread 1
    await applyMailToConversation(db, {
      ...base,
      direction: 'sent',
      occurredAt: new Date('2026-05-31T12:00:00Z'),
    }) // unread 0
    const row = await applyMailToConversation(db, {
      ...base,
      occurredAt: new Date('2026-05-31T11:00:00Z'), // stale inbound, < last outbound
    })
    expect(row.unreadCount).toBe(0)
  })

  it('backfills contactId / subject / mailAccountId when first learned', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, {
      ...base,
      contactId: null,
      subject: null,
      mailAccountId: null,
    })
    const row = await applyMailToConversation(db, {
      ...base,
      occurredAt: new Date('2026-05-31T11:00:00Z'),
      contactId: 'c_9',
      subject: 'Subject learned later',
      mailAccountId: 'acc_9',
    })
    expect(row.contactId).toBe('c_9')
    expect(row.subject).toBe('Subject learned later')
    expect(row.mailAccountId).toBe('acc_9')
  })

  it('keeps separate heads per thread', async () => {
    const { db, rows } = makeDb()
    await applyMailToConversation(db, base)
    await applyMailToConversation(db, { ...base, externalThreadId: 'thread_2' })
    expect(rows).toHaveLength(2)
  })
})
