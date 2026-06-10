// Call summary domain tests (slice B). Self-contained in-memory fake DB that
// implements only the Prisma surface addCallSummary / sendCallSummary touch.

import { describe, expect, it, vi } from 'vitest'

import { BusinessError } from '../errors'
import {
  addCallSummary,
  sendCallSummary,
  type CallSummarySenders,
  type ChannelResult,
} from './call-summary'

interface Row {
  [k: string]: unknown
}

function makeDb() {
  const cards: Row[] = []
  const contacts: Row[] = []
  const interactions: Row[] = []
  const audits: Array<{ action: string }> = []

  const db = {
    card: {
      findFirst: async ({ where }: { where: Row }) =>
        cards.find((c) => c.id === where.id && c.archivedAt == null) ?? null,
    },
    contact: {
      findFirst: async ({ where }: { where: Row }) =>
        contacts.find((c) => c.id === where.id && c.deletedAt == null) ?? null,
    },
    interaction: {
      create: async ({ data }: { data: Row }) => {
        interactions.push(data)
        return data
      },
      findFirst: async ({ where }: { where: Row }) =>
        interactions.find(
          (i) =>
            i.id === where.id &&
            (where.type === undefined || i.type === where.type) &&
            i.deletedAt == null,
        ) ?? null,
    },
    auditLogEntry: {
      findFirst: async () => null,
      create: async ({ data }: { data: { id?: string; action: string } }) => {
        audits.push({ action: data.action })
        return { id: data.id ?? 'audit' }
      },
    },
  }

  return { db: db as never, cards, contacts, interactions, audits }
}

const ctx = { actorId: 'u1', requestId: 'req1' }

function seed(t: ReturnType<typeof makeDb>) {
  t.cards.push({ id: 'card1', contactId: 'c1', archivedAt: null })
  t.contacts.push({ id: 'c1', firstName: 'Test', lastName: 'Parent', deletedAt: null })
}

describe('addCallSummary', () => {
  it('writes a call_summary Interaction on the contact and audits', async () => {
    const t = makeDb()
    seed(t)
    const result = await addCallSummary(
      t.db,
      { cardId: 'card1', authorId: 'u1', body: 'Spoke to parent, will call back', outcome: 'answered' },
      ctx,
    )
    expect(result.contactId).toBe('c1')
    expect(result.outcome).toBe('answered')
    const created = t.interactions.find((i) => i.type === 'call_summary')
    expect(created).toBeDefined()
    expect((created!.payload as Row).body).toContain('Spoke to parent')
    expect(t.audits.some((a) => a.action === 'card.call_summary_added')).toBe(true)
  })

  it('rejects an empty summary', async () => {
    const t = makeDb()
    seed(t)
    await expect(
      addCallSummary(t.db, { cardId: 'card1', authorId: 'u1', body: '   ' }, ctx),
    ).rejects.toMatchObject({ code: 'CALL_SUMMARY_EMPTY' })
  })

  it('rejects an unknown card', async () => {
    const t = makeDb()
    await expect(
      addCallSummary(t.db, { cardId: 'nope', authorId: 'u1', body: 'hi' }, ctx),
    ).rejects.toMatchObject({ code: 'CARD_NOT_FOUND' })
  })
})

describe('sendCallSummary', () => {
  async function withSummary() {
    const t = makeDb()
    seed(t)
    const summary = await addCallSummary(
      t.db,
      { cardId: 'card1', authorId: 'u1', body: 'Call summary body' },
      ctx,
    )
    return { t, summary }
  }

  it('fans out to enabled channels, records results, and audits', async () => {
    const { t, summary } = await withSummary()
    const slack = vi.fn(async (): Promise<ChannelResult> => ({ status: 'sent', ref: 'ts1' }))
    const trengo = vi.fn(async (): Promise<ChannelResult> => ({ status: 'sent', ref: '42' }))
    const email = vi.fn(async (): Promise<ChannelResult> => ({ status: 'skipped' }))
    const senders: CallSummarySenders = { slack, trengo, email }

    const results = await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { slack: true, trengo: true, email: false },
        senders,
      },
      ctx,
    )

    // Only the enabled channels are attempted.
    expect(slack).toHaveBeenCalledTimes(1)
    expect(trengo).toHaveBeenCalledTimes(1)
    expect(email).not.toHaveBeenCalled()
    expect(results.slack?.status).toBe('sent')
    expect(results.trengo?.status).toBe('sent')
    expect(results.email).toBeUndefined()

    const sentEvent = t.interactions.find((i) => i.type === 'call_summary_sent')
    expect(sentEvent).toBeDefined()
    expect((sentEvent!.payload as Row).results).toMatchObject({
      slack: { status: 'sent' },
      trengo: { status: 'sent' },
    })
    expect(t.audits.some((a) => a.action === 'card.call_summary_sent')).toBe(true)
  })

  it('continues when one channel fails (best-effort)', async () => {
    const { t, summary } = await withSummary()
    const slack = vi.fn(async (): Promise<ChannelResult> => {
      throw new BusinessError('TOKEN_EXPIRED', 'Token expired')
    })
    const email = vi.fn(async (): Promise<ChannelResult> => ({ status: 'sent', ref: 'gm1' }))

    const results = await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { slack: true, email: true },
        senders: { slack, email },
      },
      ctx,
    )

    // Slack threw but email still ran and succeeded.
    expect(results.slack?.status).toBe('failed')
    expect(results.slack?.detail).toContain('TOKEN_EXPIRED')
    expect(results.email?.status).toBe('sent')
    expect(email).toHaveBeenCalledTimes(1)
    // The send is still recorded + audited despite the partial failure.
    expect(t.interactions.some((i) => i.type === 'call_summary_sent')).toBe(true)
    expect(t.audits.some((a) => a.action === 'card.call_summary_sent')).toBe(true)
  })

  it('marks a requested channel skipped when no sender is wired', async () => {
    const { t, summary } = await withSummary()
    const results = await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { trengo: true },
        senders: {}, // no trengo sender available
      },
      ctx,
    )
    expect(results.trengo?.status).toBe('skipped')
  })

  it('rejects an unknown summary id', async () => {
    const t = makeDb()
    await expect(
      sendCallSummary(
        t.db,
        { summaryInteractionId: 'nope', channels: { slack: true }, senders: {} },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'CALL_SUMMARY_NOT_FOUND' })
  })
})

describe('sendCallSummary — wizard extensions', () => {
  async function withSummary() {
    const t = makeDb()
    seed(t)
    const summary = await addCallSummary(
      t.db,
      { cardId: 'card1', authorId: 'u1', body: 'Summary body' },
      ctx,
    )
    return { t, summary }
  }

  it('passes per-channel body overrides; un-overridden channels get the summary body', async () => {
    const { t, summary } = await withSummary()
    const email = vi.fn(async (): Promise<ChannelResult> => ({ status: 'sent' }))
    const sms = vi.fn(async (): Promise<ChannelResult> => ({ status: 'sent' }))

    await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { email: true, sms: true },
        channelBodies: { email: 'Long email version' },
        emailSubject: 'Following up',
        senders: { email, sms },
      },
      ctx,
    )

    expect(email).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Long email version', subject: 'Following up' }),
    )
    expect(sms).toHaveBeenCalledWith(expect.objectContaining({ body: 'Summary body' }))
    const sent = t.interactions.find((i) => i.type === 'call_summary_sent')
    expect((sent!.payload as Row).channelBodies).toEqual({ email: 'Long email version' })
  })

  it('routes a WhatsApp template to the sender and withholds attachments on that path', async () => {
    const { t, summary } = await withSummary()
    const whatsapp = vi.fn(
      async (_args: Record<string, unknown>): Promise<ChannelResult> => ({ status: 'sent' }),
    )
    const attachments = [
      { filename: 'pack.pdf', contentType: 'application/pdf', data: Buffer.from('x') },
    ]
    const template = {
      templateId: 7,
      templateTitle: 'UCAT info pack',
      params: [{ key: '{{1}}', value: 'Test' }],
    }

    await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { whatsapp: true },
        channelBodies: { whatsapp: 'Hi Test, your pack: link' },
        whatsappTemplate: template,
        attachments,
        senders: { whatsapp },
      },
      ctx,
    )

    const args = whatsapp.mock.calls[0]![0] as Record<string, unknown>
    expect(args.body).toBe('Hi Test, your pack: link')
    expect(args.trengoTemplate).toEqual(template)
    // Never double-deliver the pack — the approved template already links it.
    expect(args.attachments).toBeUndefined()
    const sent = t.interactions.find((i) => i.type === 'call_summary_sent')
    expect((sent!.payload as Row).whatsappTemplate).toEqual({ id: 7, title: 'UCAT info pack' })
  })

  it('keeps attachments on the free-text WhatsApp path', async () => {
    const { t, summary } = await withSummary()
    const whatsapp = vi.fn(
      async (_args: Record<string, unknown>): Promise<ChannelResult> => ({ status: 'sent' }),
    )
    const attachments = [
      { filename: 'pack.pdf', contentType: 'application/pdf', data: Buffer.from('x') },
    ]

    await sendCallSummary(
      t.db,
      {
        summaryInteractionId: summary.id,
        channels: { whatsapp: true },
        attachments,
        senders: { whatsapp },
      },
      ctx,
    )

    const args = whatsapp.mock.calls[0]![0] as Record<string, unknown>
    expect(args.attachments).toEqual(attachments)
    expect(args.trengoTemplate).toBeUndefined()
  })
})
