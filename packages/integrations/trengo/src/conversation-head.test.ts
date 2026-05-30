// Tests for the conversation-head merger. CLAUDE.md §11, ADR 0020 Phase 2.

import { describe, expect, it } from 'vitest'

import {
  applyEventToConversation,
  WHATSAPP_REPLY_WINDOW_MS,
  type ConversationHeadDb,
  type ConversationRow,
} from './conversation-head'

function fakeDb(initial: ConversationRow | null): {
  db: ConversationHeadDb
  state: { row: ConversationRow | null }
  calls: { creates: number; updates: number }
} {
  const state: { row: ConversationRow | null } = { row: initial }
  const calls = { creates: 0, updates: 0 }
  const db: ConversationHeadDb = {
    conversation: {
      findUnique: async () => state.row,
      create: async ({ data }) => {
        calls.creates += 1
        state.row = data as ConversationRow
        return state.row
      },
      update: async ({ data }) => {
        calls.updates += 1
        state.row = { ...(state.row as ConversationRow), ...data } as ConversationRow
        return state.row
      },
    },
  }
  return { db, state, calls }
}

const T0 = new Date('2026-05-30T10:00:00Z')
const T1 = new Date('2026-05-30T10:30:00Z')
const T2 = new Date('2026-05-30T11:00:00Z')

describe('applyEventToConversation', () => {
  it('creates the head on first inbound and seeds WhatsApp reply deadline', async () => {
    const { db, state, calls } = fakeDb(null)
    const row = await applyEventToConversation(db, {
      ticketId: 42,
      eventName: 'message.inbound',
      occurredAt: T0,
      channel: 'whatsapp',
      contactId: 'c_1',
    })
    expect(calls.creates).toBe(1)
    expect(row.trengoTicketId).toBe(42)
    expect(row.contactId).toBe('c_1')
    expect(row.channel).toBe('whatsapp')
    expect(row.status).toBe('open')
    expect(row.unreadCount).toBe(1)
    expect(row.replyDeadlineAt?.getTime()).toBe(T0.getTime() + WHATSAPP_REPLY_WINDOW_MS)
    expect(state.row?.id).toBeTruthy()
  })

  it('outbound clears unread and stamps lastOutboundAt', async () => {
    const { db } = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: 'c_1',
      familyId: null,
      channel: 'whatsapp',
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T0,
      lastInboundAt: T0,
      lastOutboundAt: null,
      unreadCount: 3,
      subject: null,
      tags: [],
      replyDeadlineAt: new Date(T0.getTime() + WHATSAPP_REPLY_WINDOW_MS),
    })
    const row = await applyEventToConversation(db, {
      ticketId: 42,
      eventName: 'message.outbound',
      occurredAt: T1,
    })
    expect(row.unreadCount).toBe(0)
    expect(row.lastOutboundAt?.getTime()).toBe(T1.getTime())
    expect(row.lastMessageAt.getTime()).toBe(T1.getTime())
  })

  it('does not bump unread for an inbound that pre-dates the latest outbound', async () => {
    // Out-of-order delivery: outbound at T2 already happened; an inbound at
    // T1 (older) shouldn't re-raise the unread counter.
    const { db } = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: 'c_1',
      familyId: null,
      channel: 'sms',
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T2,
      lastInboundAt: T0,
      lastOutboundAt: T2,
      unreadCount: 0,
      subject: null,
      tags: [],
      replyDeadlineAt: null,
    })
    const row = await applyEventToConversation(db, {
      ticketId: 42,
      eventName: 'message.inbound',
      occurredAt: T1,
    })
    expect(row.unreadCount).toBe(0)
  })

  it('ticket.closed → status closed; ticket.reopened → status open', async () => {
    const seed: ConversationRow = {
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: null,
      familyId: null,
      channel: null,
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T0,
      lastInboundAt: null,
      lastOutboundAt: null,
      unreadCount: 0,
      subject: null,
      tags: [],
      replyDeadlineAt: null,
    }
    const ctx1 = fakeDb({ ...seed })
    const closed = await applyEventToConversation(ctx1.db, {
      ticketId: 42,
      eventName: 'ticket.closed',
      occurredAt: T1,
    })
    expect(closed.status).toBe('closed')

    const ctx2 = fakeDb({ ...seed, status: 'closed' })
    const reopened = await applyEventToConversation(ctx2.db, {
      ticketId: 42,
      eventName: 'ticket.reopened',
      occurredAt: T2,
    })
    expect(reopened.status).toBe('open')
  })

  it('label.added and label.removed maintain the tag set', async () => {
    const ctx = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: null,
      familyId: null,
      channel: null,
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T0,
      lastInboundAt: null,
      lastOutboundAt: null,
      unreadCount: 0,
      subject: null,
      tags: ['vip'],
      replyDeadlineAt: null,
    })
    const added = await applyEventToConversation(ctx.db, {
      ticketId: 42,
      eventName: 'label.added',
      occurredAt: T1,
      label: 'urgent',
    })
    expect(added.tags).toEqual(['vip', 'urgent'])

    const removed = await applyEventToConversation(ctx.db, {
      ticketId: 42,
      eventName: 'label.removed',
      occurredAt: T2,
      label: 'vip',
    })
    expect(removed.tags).toEqual(['urgent'])
  })

  it('ticket.assigned records both trengoAssigneeId and assigneeUserId when provided', async () => {
    const ctx = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: null,
      familyId: null,
      channel: null,
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T0,
      lastInboundAt: null,
      lastOutboundAt: null,
      unreadCount: 0,
      subject: null,
      tags: [],
      replyDeadlineAt: null,
    })
    const row = await applyEventToConversation(ctx.db, {
      ticketId: 42,
      eventName: 'ticket.assigned',
      occurredAt: T1,
      trengoAssigneeId: 7,
      assigneeUserId: 'u_1',
    })
    expect(row.trengoAssigneeId).toBe(7)
    expect(row.assigneeUserId).toBe('u_1')
  })

  it('lastMessageAt is monotonic — older events do not move the clock backwards', async () => {
    const ctx = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: null,
      familyId: null,
      channel: 'sms',
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T2,
      lastInboundAt: T2,
      lastOutboundAt: null,
      unreadCount: 1,
      subject: null,
      tags: [],
      replyDeadlineAt: null,
    })
    const row = await applyEventToConversation(ctx.db, {
      ticketId: 42,
      eventName: 'message.inbound',
      occurredAt: T0,
    })
    expect(row.lastMessageAt.getTime()).toBe(T2.getTime())
  })

  it('subject is filled when first provided, never overwritten', async () => {
    const ctx = fakeDb({
      id: 'conv_1',
      trengoTicketId: 42,
      contactId: null,
      familyId: null,
      channel: 'email',
      status: 'open',
      assigneeUserId: null,
      trengoAssigneeId: null,
      lastMessageAt: T0,
      lastInboundAt: T0,
      lastOutboundAt: null,
      unreadCount: 1,
      subject: 'Booking confirmation',
      tags: [],
      replyDeadlineAt: null,
    })
    const row = await applyEventToConversation(ctx.db, {
      ticketId: 42,
      eventName: 'message.inbound',
      occurredAt: T1,
      subject: 'Re: Booking confirmation',
    })
    expect(row.subject).toBe('Booking confirmation')
  })
})
