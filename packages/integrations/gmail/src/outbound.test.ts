// Tests for the Gmail outbound reply path. CLAUDE.md §14.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Stub @studymind/db with an in-memory shape good enough for the outbound.
const ROWS = {
  intents: [] as Array<{
    id: string
    agentId: string
    threadId: string
    requestId: string
    gmailMessageId: string | null
    subject: string
    toAddresses: string[]
    ccAddresses: string[]
    bccAddresses: string[]
    status: string
  }>,
  contacts: [] as Array<{ id: string; email: string }>,
  interactions: [] as Array<Record<string, unknown>>,
  audits: [] as Array<Record<string, unknown>>,
}

const sendMessageStub = vi.fn()

vi.mock('@studymind/db', () => {
  return {
    db: {
      outboundEmailIntent: {
        findUnique: vi.fn(async (args: { where: { threadId_requestId: { threadId: string; requestId: string } } }) => {
          return ROWS.intents.find(
            (r) =>
              r.threadId === args.where.threadId_requestId.threadId &&
              r.requestId === args.where.threadId_requestId.requestId,
          ) ?? null
        }),
        create: vi.fn(async (args: { data: { id: string; agentId: string; threadId: string; requestId: string; subject: string; toAddresses: string[]; ccAddresses?: string[]; bccAddresses?: string[]; status: string } }) => {
          ROWS.intents.push({
            id: args.data.id,
            agentId: args.data.agentId,
            threadId: args.data.threadId,
            requestId: args.data.requestId,
            gmailMessageId: null,
            subject: args.data.subject,
            toAddresses: args.data.toAddresses ?? [],
            ccAddresses: args.data.ccAddresses ?? [],
            bccAddresses: args.data.bccAddresses ?? [],
            status: args.data.status ?? 'pending',
          })
          return ROWS.intents[ROWS.intents.length - 1]
        }),
        update: vi.fn(async (args: { where: { id: string }; data: Partial<{ gmailMessageId: string; status: string }> }) => {
          const row = ROWS.intents.find((r) => r.id === args.where.id)
          if (!row) throw new Error('not found')
          Object.assign(row, args.data)
          return row
        }),
      },
      contact: {
        findMany: vi.fn(
          async (args: {
            where: { OR: Array<{ email: { equals: string; mode: string } }> }
          }) => {
            // Case-insensitive OR match (sendReply / sendEmail now match a
            // mixed-case contact email via `{ email: { equals, mode } }`).
            const wanted = args.where.OR.map((o) => o.email.equals.toLowerCase())
            return ROWS.contacts.filter((c) => wanted.includes(c.email.toLowerCase()))
          },
        ),
      },
      interaction: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          ROWS.interactions.push(args.data)
          return args.data
        }),
      },
      auditLogEntry: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          ROWS.audits.push(args.data)
          return args.data
        }),
      },
      $transaction: async <T,>(promises: Promise<T>[]): Promise<T[]> => Promise.all(promises),
    },
  }
})

vi.mock('@studymind/audit', () => ({
  writeAuditLogEntry: vi.fn(async (_db, payload) => {
    ROWS.audits.push(payload as Record<string, unknown>)
    return 'audit_1'
  }),
}))

vi.mock('./client', () => ({
  createClientForAgent: vi.fn(async () => ({
    agentId: 'u_1',
    sendMessage: sendMessageStub,
    getMessage: vi.fn(),
    listHistorySince: vi.fn(),
    setupWatch: vi.fn(),
    stopWatch: vi.fn(),
    getAttachment: vi.fn(),
  })),
}))

import { buildRawReply, sendReply } from './outbound'

beforeEach(() => {
  ROWS.intents.length = 0
  ROWS.contacts.length = 0
  ROWS.interactions.length = 0
  ROWS.audits.length = 0
  sendMessageStub.mockReset()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('buildRawReply', () => {
  it('decodes back to a parseable RFC 5322 message with threading headers', () => {
    const { raw, subject } = buildRawReply({
      subject: 'Trial slot Tuesday',
      toAddresses: ['parent@example.com'],
      cc: ['student@example.com'],
      body: 'Confirmed — see you Tuesday.',
      originalMessageId: '<abc123@mail.gmail.com>',
    })
    expect(subject).toBe('Re: Trial slot Tuesday')
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toMatch(/^To: parent@example\.com\r\n/m)
    expect(decoded).toMatch(/^Subject: Re: Trial slot Tuesday\r\n/m)
    expect(decoded).toMatch(/^In-Reply-To: <abc123@mail\.gmail\.com>\r\n/m)
    expect(decoded).toMatch(/^References: <abc123@mail\.gmail\.com>\r\n/m)
    expect(decoded).toMatch(/^Cc: student@example\.com\r\n/m)
    // Body separated by blank line.
    expect(decoded).toMatch(/\r\n\r\nConfirmed — see you Tuesday\.$/)
  })

  it('does not double the Re: prefix', () => {
    const { subject } = buildRawReply({
      subject: 'Re: Re:   Re: Original',
      toAddresses: ['a@b.com'],
      body: 'x',
    })
    expect(subject).toBe('Re: Original')
  })

  it('uses the subject verbatim for a brand-new email (literalSubject)', () => {
    const { raw, subject } = buildRawReply({
      subject: 'Welcome to StudyMind',
      toAddresses: ['parent@example.com'],
      body: 'Hello.',
      literalSubject: true,
    })
    expect(subject).toBe('Welcome to StudyMind')
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toMatch(/^Subject: Welcome to StudyMind\r\n/m)
    // No threading headers on a fresh compose.
    expect(decoded).not.toMatch(/In-Reply-To:/)
  })

  it('emits a multipart/mixed body with base64 attachments when given some', () => {
    const pdfBytes = Buffer.from('%PDF-1.4 minimal pdf bytes for the test')
    const { raw, headers } = buildRawReply({
      subject: 'Call summary',
      toAddresses: ['parent@example.com'],
      body: 'See attached call summary script.',
      attachments: [
        {
          filename: 'ucat-script.pdf',
          contentType: 'application/pdf',
          data: pdfBytes,
        },
      ],
      boundarySeed: 'deterministicseed',
    })
    expect(headers['Content-Type']).toMatch(/^multipart\/mixed; boundary="/)
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    // Boundary line, text part, attachment part with base64 body, closing boundary.
    expect(decoded).toMatch(/\r\n--==SMCRM_deterministicseed==\r\n/)
    expect(decoded).toMatch(/Content-Type: text\/plain; charset=UTF-8\r\n/)
    expect(decoded).toMatch(/See attached call summary script\./)
    expect(decoded).toMatch(/Content-Type: application\/pdf; name="ucat-script\.pdf"/)
    expect(decoded).toMatch(
      /Content-Disposition: attachment; filename="ucat-script\.pdf"/,
    )
    expect(decoded).toMatch(/Content-Transfer-Encoding: base64\r\n/)
    expect(decoded).toMatch(/\r\n--==SMCRM_deterministicseed==--\r\n$/)
    // Encoded bytes round-trip.
    const b64 = pdfBytes.toString('base64')
    expect(decoded).toContain(b64)
  })

  it('emits multipart/alternative (text + html) when given an html body', () => {
    const { raw, headers } = buildRawReply({
      subject: 'Welcome',
      toAddresses: ['parent@example.com'],
      body: 'Hello there.',
      html: '<p>Hello <b>there</b>.</p>',
      literalSubject: true,
      boundarySeed: 'altseed',
    })
    expect(headers['Content-Type']).toMatch(/^multipart\/alternative; boundary="/)
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toMatch(/Content-Type: text\/plain; charset=UTF-8\r\n/)
    expect(decoded).toMatch(/Hello there\./)
    expect(decoded).toMatch(/Content-Type: text\/html; charset=UTF-8\r\n/)
    expect(decoded).toMatch(/<p>Hello <b>there<\/b>\.<\/p>/)
    expect(decoded).toMatch(/\r\n--==SMCRM_altseed==--\r\n$/)
  })

  it('nests multipart/alternative inside multipart/mixed when html + attachments', () => {
    const { raw, headers } = buildRawReply({
      subject: 'x',
      toAddresses: ['a@b.com'],
      body: 'plain',
      html: '<p>rich</p>',
      attachments: [
        { filename: 'f.pdf', contentType: 'application/pdf', data: Buffer.from('PDF') },
      ],
      boundarySeed: 'mix',
    })
    expect(headers['Content-Type']).toMatch(/^multipart\/mixed; boundary="==SMCRM_mix=="/)
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    // The alternative block is nested under the mixed boundary with its own.
    expect(decoded).toMatch(/Content-Type: multipart\/alternative; boundary="==SMCRM_mixalt=="/)
    expect(decoded).toMatch(/Content-Type: text\/html; charset=UTF-8/)
    expect(decoded).toMatch(/<p>rich<\/p>/)
    expect(decoded).toMatch(/Content-Disposition: attachment; filename="f\.pdf"/)
    expect(decoded).toMatch(/\r\n--==SMCRM_mix==--\r\n$/)
  })

  it('escapes CR/LF/quote in attachment filenames so headers cannot be injected', () => {
    const { raw } = buildRawReply({
      subject: 'x',
      toAddresses: ['a@b.com'],
      body: 'x',
      attachments: [
        {
          filename: 'bad"\r\nname.pdf',
          contentType: 'application/pdf',
          data: Buffer.from('x'),
        },
      ],
      boundarySeed: 'b',
    })
    const decoded = Buffer.from(raw, 'base64url').toString('utf8')
    expect(decoded).toMatch(/filename="bad___name\.pdf"/)
  })
})

describe('sendReply', () => {
  it('idempotent on (threadId, requestId) — second call short-circuits', async () => {
    sendMessageStub.mockResolvedValueOnce({ id: 'g_msg_1', threadId: 't_1' })
    const first = await sendReply({
      agentId: 'u_1',
      threadId: 't_1',
      subject: 'Hello',
      body: 'first',
      toAddresses: ['parent@example.com'],
      requestId: 'req_dedupe',
    })
    expect(first.replayed).toBe(false)
    expect(sendMessageStub).toHaveBeenCalledTimes(1)

    const second = await sendReply({
      agentId: 'u_1',
      threadId: 't_1',
      subject: 'Hello',
      body: 'first',
      toAddresses: ['parent@example.com'],
      requestId: 'req_dedupe',
    })
    expect(second.replayed).toBe(true)
    expect(second.gmailMessageId).toBe('g_msg_1')
    expect(sendMessageStub).toHaveBeenCalledTimes(1)
  })

  it('creates one Interaction per matched Contact across to/cc', async () => {
    ROWS.contacts.push({ id: 'ctc_1', email: 'parent@example.com' })
    ROWS.contacts.push({ id: 'ctc_2', email: 'student@example.com' })
    sendMessageStub.mockResolvedValueOnce({ id: 'g_msg_x', threadId: 't_x' })

    await sendReply({
      agentId: 'u_1',
      threadId: 't_x',
      subject: 'Slot',
      body: 'text',
      toAddresses: ['parent@example.com'],
      cc: ['student@example.com'],
      requestId: 'req_x',
    })

    expect(ROWS.interactions).toHaveLength(2)
    const contactIds = ROWS.interactions.map((i) => i['contactId']).sort()
    expect(contactIds).toEqual(['ctc_1', 'ctc_2'])
  })

  it('marks the intent failed and rethrows on Gmail error', async () => {
    sendMessageStub.mockRejectedValueOnce(new Error('boom'))
    await expect(
      sendReply({
        agentId: 'u_1',
        threadId: 't_fail',
        subject: 'fail',
        body: 'x',
        toAddresses: ['x@y.com'],
        requestId: 'req_fail',
      }),
    ).rejects.toThrow('boom')
    expect(ROWS.intents[0]?.status).toBe('failed')
  })
})
