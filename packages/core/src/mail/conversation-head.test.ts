// applyMailToConversation tests (ADR 0021 Phase 3b). In-memory conversation
// store; verifies create, monotonic merges, unread tracking, and idempotency.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  applyMailFlagsToConversation,
  applyMailToConversation,
  type ApplyMailInput,
  type MailConversationDb,
  type MailConversationRow,
  type MailThreadFlags,
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
        // Mirror the DB column defaults the create input omits.
        const row = {
          isStarred: false,
          isTrashed: false,
          flagsSyncedAt: null,
          ...data,
        } as unknown as MailConversationRow
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

describe('applyMailToConversation — sender name', () => {
  it('stores the inbound sender name on create', async () => {
    const { db } = makeDb()
    const row = await applyMailToConversation(db, { ...base, senderName: 'Stripe' })
    expect(row.lastSenderName).toBe('Stripe')
  })

  it('FILLS a blank lastSenderName on a later (non-advancing) message — heals legacy heads', async () => {
    const { db } = makeDb()
    // Head created with no sender (older sync that didn't capture it).
    await applyMailToConversation(db, { ...base, senderName: null })
    // Re-applying the SAME message timestamp (does not advance the clock) but
    // now WITH a sender must still backfill the blank.
    const row = await applyMailToConversation(db, { ...base, senderName: 'noreply@studymind.co.uk' })
    expect(row.lastSenderName).toBe('noreply@studymind.co.uk')
  })

  it('advances lastSenderName to the newest inbound sender', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, { ...base, senderName: 'First Sender' })
    const row = await applyMailToConversation(db, {
      ...base,
      occurredAt: new Date('2026-06-01T10:00:00Z'),
      senderName: 'Second Sender',
    })
    expect(row.lastSenderName).toBe('Second Sender')
  })
})

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

describe('applyMailFlagsToConversation (inbound two-way mirror)', () => {
  const READ_INBOX: MailThreadFlags = {
    isRead: true,
    isStarred: false,
    isArchived: false,
    isTrashed: false,
  }
  const syncedAt = new Date('2026-06-01T09:00:00Z')

  it('returns null when no head exists yet (nothing to mirror onto)', async () => {
    const { db } = makeDb()
    const res = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'missing',
      flags: READ_INBOX,
      syncedAt,
    })
    expect(res).toBeNull()
  })

  it('clears unread when Gmail marks the thread read', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base) // unread 1
    const row = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: READ_INBOX,
      syncedAt,
    })
    expect(row?.unreadCount).toBe(0)
    expect(row?.flagsSyncedAt).toEqual(syncedAt)
  })

  it('mirrors star on and off', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base)
    const on = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: { ...READ_INBOX, isStarred: true },
      syncedAt,
    })
    expect(on?.isStarred).toBe(true)
    const off = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: READ_INBOX,
      syncedAt,
    })
    expect(off?.isStarred).toBe(false)
  })

  it('archived in Gmail moves the head to archived; restored moves it back to open', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base)
    const archived = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: { ...READ_INBOX, isArchived: true },
      syncedAt,
    })
    expect(archived?.status).toBe('archived')
    const restored = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: READ_INBOX,
      syncedAt,
    })
    expect(restored?.status).toBe('open')
  })

  it('trashed in Gmail sets isTrashed + archives the head', async () => {
    const { db } = makeDb()
    await applyMailToConversation(db, base)
    const row = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: { isRead: true, isStarred: false, isArchived: false, isTrashed: true },
      syncedAt,
    })
    expect(row?.isTrashed).toBe(true)
    expect(row?.status).toBe('archived')
  })

  it('never clobbers a CRM-only closed/snoozed status', async () => {
    const { db, rows } = makeDb()
    await applyMailToConversation(db, base)
    rows[0]!.status = 'snoozed'
    const row = await applyMailFlagsToConversation(db, {
      provider: 'email',
      externalThreadId: 'thread_1',
      flags: { ...READ_INBOX, isArchived: true },
      syncedAt,
    })
    expect(row?.status).toBe('snoozed')
  })
})
