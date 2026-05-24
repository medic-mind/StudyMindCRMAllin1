// Unit tests for the per-channel view-models. Uses a stubbed PrismaClient
// that returns the rows we pass in — the constructors are pure data shapers
// so this proves the grouping, threading, and outcome-classification rules
// without booting a real DB.

import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'

import {
  callsForContact,
  channelSummaryForContact,
  emailThreadsForContact,
  notesForContact,
  searchAcrossChannels,
  slackMentionsForContact,
  tasksForContact,
  trengoConversationsForContact,
} from './contact-channels'

interface InteractionRow {
  id: string
  type: string
  occurredAt: Date
  summary: string | null
  payload: unknown
  createdById?: string | null
}

function makeDb(opts: {
  interactions?: InteractionRow[]
  tasks?: Array<{
    id: string
    title: string
    status: string
    dueAt: Date | null
    assigneeId: string | null
    description: string | null
  }>
}): PrismaClient {
  const interactions = opts.interactions ?? []
  const tasks = opts.tasks ?? []
  return {
    interaction: {
      findMany: async (args: {
        where: { type?: string | { in: string[] }; OR?: unknown[] }
        take?: number
      }) => {
        const t = args.where.type
        let rows = interactions.slice()
        if (typeof t === 'string') rows = rows.filter((r) => r.type === t)
        else if (t && typeof t === 'object' && Array.isArray(t.in)) {
          const allowed = new Set(t.in)
          rows = rows.filter((r) => allowed.has(r.type))
        }
        const ws = args.where as { OR?: Array<{ summary?: { contains?: string } }> }
        if (ws.OR) {
          const needle = ws.OR.find((o) => o.summary?.contains)?.summary?.contains
          if (needle) {
            const n = needle.toLowerCase()
            rows = rows.filter((r) => (r.summary ?? '').toLowerCase().includes(n))
          }
        }
        rows.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
        return rows.slice(0, args.take ?? 50).map((r) => ({
          ...r,
          createdById: r.createdById ?? null,
        }))
      },
      aggregate: async (args: { where: { type: string } }) => {
        const rows = interactions.filter((r) => r.type === args.where.type)
        const latest = rows
          .map((r) => r.occurredAt)
          .sort((a, b) => b.getTime() - a.getTime())[0]
        return {
          _count: { id: rows.length },
          _max: { occurredAt: latest ?? null },
        }
      },
    },
    task: {
      count: async () => tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
      findMany: async () => tasks,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any
}

describe('emailThreadsForContact', () => {
  it('groups by gmailThreadId, orders by latest message, counts unread', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 'i1',
          type: 'email_received',
          occurredAt: new Date('2026-05-20T10:00:00Z'),
          summary: 'Hello',
          payload: {
            gmailThreadId: 'T1',
            subject: 'Welcome',
            from: ['parent@example.com'],
            to: ['agent@studymind.co'],
            cc: [],
            bcc: [],
            labels: ['INBOX', 'UNREAD'],
          },
        },
        {
          id: 'i2',
          type: 'email_sent',
          occurredAt: new Date('2026-05-21T10:00:00Z'),
          summary: 'Re: Welcome',
          payload: {
            gmailThreadId: 'T1',
            subject: 'Re: Welcome',
            from: ['agent@studymind.co'],
            to: ['parent@example.com'],
            cc: [],
            bcc: [],
            labels: [],
          },
        },
        {
          id: 'i3',
          type: 'email_received',
          occurredAt: new Date('2026-05-22T10:00:00Z'),
          summary: 'Different',
          payload: { gmailThreadId: 'T2', subject: 'Different', from: ['x@y.co'], to: [], cc: [], bcc: [], labels: ['UNREAD'] },
        },
      ],
    })
    const out = await emailThreadsForContact(db, { contactId: 'c1' })
    expect(out.items).toHaveLength(2)
    expect(out.items[0]?.threadId).toBe('T2') // newest thread first
    const t1 = out.items.find((t) => t.threadId === 'T1')
    expect(t1?.messageCount).toBe(2)
    expect(t1?.unreadCount).toBe(1)
    expect(t1?.messages.map((m) => m.id)).toEqual(['i1', 'i2'])
  })

  it('returns empty paginated when no rows', async () => {
    const db = makeDb({ interactions: [] })
    const out = await emailThreadsForContact(db, { contactId: 'c1' })
    expect(out.items).toEqual([])
    expect(out.nextCursor).toBeNull()
  })
})

describe('callsForContact', () => {
  it('classifies outcomes from payload', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 'c1',
          type: 'call',
          occurredAt: new Date('2026-05-20T10:00:00Z'),
          summary: 'Inbound call',
          payload: {
            interactionType: 'call.voicemail_left',
            direction: 'inbound',
            aircallCallId: 999,
          },
        },
        {
          id: 'c2',
          type: 'call',
          occurredAt: new Date('2026-05-21T10:00:00Z'),
          summary: 'Answered',
          payload: {
            interactionType: 'call.answered',
            direction: 'outbound',
            durationSec: 120,
          },
        },
      ],
    })
    const out = await callsForContact(db, { contactId: 'c1' })
    expect(out.items[0]?.outcome).toBe('answered')
    expect(out.items[1]?.outcome).toBe('voicemail')
  })
})

describe('slackMentionsForContact', () => {
  it('maps payload to mention shape', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 's1',
          type: 'slack_summary',
          occurredAt: new Date(),
          summary: 'Parent unhappy with tutor',
          payload: {
            channelId: 'C123',
            channelName: 'ops',
            sentiment: 'negative',
            suggestedNextAction: 'call back',
            confidence: 0.9,
          },
        },
      ],
    })
    const out = await slackMentionsForContact(db, { contactId: 'c1' })
    expect(out.items[0]?.sentiment).toBe('negative')
    expect(out.items[0]?.confidence).toBe(0.9)
  })
})

describe('trengoConversationsForContact', () => {
  it('groups by ticketId and surfaces WhatsApp 24h deadline', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 't1',
          type: 'message',
          occurredAt: new Date('2026-05-20T10:00:00Z'),
          summary: 'hi',
          payload: { ticketId: 555, channel: 'whatsapp', interactionType: 'message.inbound' },
        },
        {
          id: 't2',
          type: 'message',
          occurredAt: new Date('2026-05-20T12:00:00Z'),
          summary: 'thanks',
          payload: { ticketId: 555, channel: 'whatsapp', interactionType: 'message.outbound' },
        },
      ],
    })
    const out = await trengoConversationsForContact(db, { contactId: 'c1' })
    expect(out.items).toHaveLength(1)
    expect(out.items[0]?.messageCount).toBe(2)
    expect(out.items[0]?.replyDeadlineAt).toBeInstanceOf(Date)
  })
})

describe('tasksForContact', () => {
  it('splits open vs closed', async () => {
    const db = makeDb({
      tasks: [
        { id: 'ta1', title: 't', status: 'open', dueAt: null, assigneeId: null, description: null },
        { id: 'ta2', title: 't', status: 'done', dueAt: null, assigneeId: null, description: null },
      ],
    })
    const out = await tasksForContact(db, { contactId: 'c1' })
    expect(out.open).toHaveLength(1)
    expect(out.closed).toHaveLength(1)
  })
})

describe('notesForContact', () => {
  it('maps payload body to entry', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 'n1',
          type: 'note',
          occurredAt: new Date(),
          summary: 'follow up',
          payload: { body: 'Mum asked us to call back after school.' },
          createdById: 'u1',
        },
      ],
    })
    const out = await notesForContact(db, { contactId: 'c1' })
    expect(out.items[0]?.body).toContain('Mum')
    expect(out.items[0]?.authorId).toBe('u1')
  })
})

describe('channelSummaryForContact', () => {
  it('aggregates counts per channel', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 'e1',
          type: 'email_received',
          occurredAt: new Date('2026-05-20T10:00:00Z'),
          summary: 'x',
          payload: { gmailThreadId: 'TA', labels: ['UNREAD'] },
        },
        {
          id: 'c1',
          type: 'call',
          occurredAt: new Date(),
          summary: 'x',
          payload: { interactionType: 'call.ended', durationSec: 0 },
        },
        {
          id: 'n1',
          type: 'note',
          occurredAt: new Date(),
          summary: 'x',
          payload: { body: 'x' },
        },
      ],
    })
    const out = await channelSummaryForContact(db, 'c1')
    expect(out.emails.threadCount).toBe(1)
    expect(out.emails.unreadCount).toBe(1)
    expect(out.calls.missedCount).toBe(1)
    expect(out.notes.count).toBe(1)
  })
})

describe('searchAcrossChannels', () => {
  it('returns empty on short queries', async () => {
    const db = makeDb({})
    const out = await searchAcrossChannels(db, 'c1', 'a')
    expect(out).toEqual([])
  })

  it('matches by summary substring across channels', async () => {
    const db = makeDb({
      interactions: [
        {
          id: 'e1',
          type: 'email_received',
          occurredAt: new Date(),
          summary: 'Please review the EHCP draft',
          payload: { gmailThreadId: 'T1' },
        },
        {
          id: 'n1',
          type: 'note',
          occurredAt: new Date(),
          summary: 'Note about pricing — irrelevant',
          payload: { body: 'x' },
        },
      ],
    })
    const out = await searchAcrossChannels(db, 'c1', 'EHCP')
    expect(out).toHaveLength(1)
    expect(out[0]?.channel).toBe('email')
  })
})
