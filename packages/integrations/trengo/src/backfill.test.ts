// Tests for the Trengo historic-import parsing + fetch layer (ADR 0017).
//
// The Inngest function itself is orchestration (paging + DB writes) and is
// exercised against staging; what we pin here is the part that broke in the
// field — the listing endpoint (documented `/tickets`, with the legacy
// `/conversations` fallback), the pagination contract, and the defensive
// parsing of ticket/message rows whose shapes vary across Trengo versions.

import { describe, expect, it, vi } from 'vitest'

import {
  buildUserNameMap,
  extractTicketAssigneeId,
  extractMessageBody,
  extractTicketLabels,
  inferMessageDirection,
  listTicketsPage,
  normaliseTicketChannel,
  normaliseTicketRow,
  parseListResponse,
  parseTrengoDate,
  ticketWithinWindow,
} from './backfill'
import { TrengoApiError } from './client'

describe('parseTrengoDate', () => {
  it('parses ISO 8601 strings', () => {
    expect(parseTrengoDate('2026-05-30T10:00:00Z')?.toISOString()).toBe(
      '2026-05-30T10:00:00.000Z',
    )
  })

  it('parses Trengo space-separated timestamps as UTC', () => {
    expect(parseTrengoDate('2026-05-30 10:00:00')?.toISOString()).toBe(
      '2026-05-30T10:00:00.000Z',
    )
  })

  it('returns null on garbage, empty, and non-strings', () => {
    expect(parseTrengoDate('not a date')).toBeNull()
    expect(parseTrengoDate('')).toBeNull()
    expect(parseTrengoDate(undefined)).toBeNull()
    expect(parseTrengoDate(1717000000)).toBeNull()
  })
})

describe('normaliseTicketChannel', () => {
  it('accepts our lowercase channel names directly', () => {
    expect(normaliseTicketChannel('whatsapp')).toBe('whatsapp')
    expect(normaliseTicketChannel('web_chat')).toBe('web_chat')
  })

  it('maps Trengo channel type tags', () => {
    expect(normaliseTicketChannel('WA_BUSINESS')).toBe('whatsapp')
    expect(normaliseTicketChannel('SMS')).toBe('sms')
    expect(normaliseTicketChannel('EMAIL')).toBe('email')
    expect(normaliseTicketChannel('CHAT')).toBe('web_chat')
  })

  it('reads a channel object by type, then name', () => {
    expect(normaliseTicketChannel({ type: 'WA_BUSINESS', name: 'Support line' })).toBe(
      'whatsapp',
    )
    expect(normaliseTicketChannel({ name: 'email' })).toBe('email')
  })

  it('returns null for unknown channels (Facebook, Telegram, …)', () => {
    expect(normaliseTicketChannel('FACEBOOK')).toBeNull()
    expect(normaliseTicketChannel({ type: 'TELEGRAM' })).toBeNull()
    expect(normaliseTicketChannel(null)).toBeNull()
    expect(normaliseTicketChannel(42)).toBeNull()
  })
})

describe('inferMessageDirection', () => {
  it('honours an explicit direction field', () => {
    expect(inferMessageDirection({ direction: 'outbound' })).toBe('message.outbound')
    expect(inferMessageDirection({ direction: 'inbound' })).toBe('message.inbound')
  })

  it('falls back to the type field, case-insensitively', () => {
    expect(inferMessageDirection({ type: 'OUTBOUND' })).toBe('message.outbound')
    expect(inferMessageDirection({ type: 'INBOUND' })).toBe('message.inbound')
  })

  it('treats an agent-sent row (user_id, no contact_id) as outbound', () => {
    expect(inferMessageDirection({ user_id: 7 })).toBe('message.outbound')
    expect(inferMessageDirection({ user_id: 7, contact_id: 3 })).toBe('message.inbound')
  })

  it('defaults to inbound', () => {
    expect(inferMessageDirection({})).toBe('message.inbound')
  })
})

describe('extractMessageBody', () => {
  it('reads body, then message, then text', () => {
    expect(extractMessageBody({ body: 'a' })).toBe('a')
    expect(extractMessageBody({ message: 'b' })).toBe('b')
    expect(extractMessageBody({ text: 'c' })).toBe('c')
    expect(extractMessageBody({ body: '', message: 'b' })).toBe('b')
  })

  it('returns null when no body field is usable', () => {
    expect(extractMessageBody({})).toBeNull()
    expect(extractMessageBody({ body: '   ' })).toBeNull()
  })
})

describe('parseListResponse', () => {
  it('pages via meta.last_page', () => {
    const res = { data: [{ id: 1 }], meta: { last_page: 3, total: 120 } }
    expect(parseListResponse(res, 1)).toEqual({
      rows: [{ id: 1 }],
      hasNext: true,
      total: 120,
    })
    expect(parseListResponse(res, 3).hasNext).toBe(false)
  })

  it('falls back to links.next when meta is absent', () => {
    const res = { data: [{ id: 1 }], links: { next: 'https://x/tickets?page=2' } }
    expect(parseListResponse(res, 1).hasNext).toBe(true)
    expect(parseListResponse({ data: [{ id: 1 }], links: { next: null } }, 1).hasNext).toBe(
      false,
    )
  })

  it('accepts a bare array and never pages it', () => {
    expect(parseListResponse([{ id: 1 }], 1)).toEqual({
      rows: [{ id: 1 }],
      hasNext: false,
      total: 1,
    })
  })

  it('never reports hasNext on an empty page (malformed meta cannot loop)', () => {
    expect(parseListResponse({ data: [], meta: { last_page: 99 } }, 1).hasNext).toBe(false)
  })
})

describe('normaliseTicketRow', () => {
  it('requires a numeric id', () => {
    expect(normaliseTicketRow({ status: 'OPEN' })).toBeNull()
    expect(normaliseTicketRow(null)).toBeNull()
    expect(normaliseTicketRow('x')).toBeNull()
  })

  it('folds Trengo statuses to open/closed', () => {
    expect(normaliseTicketRow({ id: 1, status: 'CLOSED' })?.status).toBe('closed')
    expect(normaliseTicketRow({ id: 1, status: 'OPEN' })?.status).toBe('open')
    expect(normaliseTicketRow({ id: 1, status: 'ASSIGNED' })?.status).toBe('open')
    expect(normaliseTicketRow({ id: 1 })?.status).toBe('open')
  })

  it('normalises contact details (trim, lowercase email)', () => {
    const t = normaliseTicketRow({
      id: 9,
      contact: { phone: ' +447700900123 ', email: ' Parent@Example.COM ', name: ' Jo Smith ' },
      channel: { type: 'WA_BUSINESS' },
      created_at: '2026-05-30 10:00:00',
      subject: 'Re: trial lesson',
      labels: [{ id: 1, name: 'GCSE' }, { id: 2, name: 'Billing' }],
    })
    expect(t).toEqual({
      id: 9,
      channel: 'whatsapp',
      trengoChannelId: null,
      trengoChannelName: null,
      status: 'open',
      assigneeId: null,
      subject: 'Re: trial lesson',
      labels: ['GCSE', 'Billing'],
      labelsKnown: true,
      contact: { phone: '+447700900123', email: 'parent@example.com', name: 'Jo Smith' },
      createdAt: new Date('2026-05-30T10:00:00.000Z'),
    })
  })

  it('distinguishes "no labels" from "listing carried no labels key"', () => {
    expect(normaliseTicketRow({ id: 1, labels: [] })?.labelsKnown).toBe(true)
    expect(normaliseTicketRow({ id: 1, tags: [] })?.labelsKnown).toBe(true)
    expect(normaliseTicketRow({ id: 1 })?.labelsKnown).toBe(false)
  })

  it('extracts the specific channel id + name ("business number")', () => {
    const t = normaliseTicketRow({
      id: 5,
      channel: { id: 42, name: 'Tutor Manager', type: 'WA_BUSINESS' },
    })
    expect(t?.trengoChannelId).toBe(42)
    expect(t?.trengoChannelName).toBe('Tutor Manager')
    expect(t?.channel).toBe('whatsapp')
  })

  it('reads a flat channel_id when there is no channel object', () => {
    const t = normaliseTicketRow({ id: 6, channel_id: 99 })
    expect(t?.trengoChannelId).toBe(99)
    expect(t?.trengoChannelName).toBeNull()
  })

  it('imports the Trengo Spam box (status SPAM / is_spam) as spam', () => {
    expect(normaliseTicketRow({ id: 1, status: 'SPAM' })?.status).toBe('spam')
    expect(normaliseTicketRow({ id: 2, is_spam: true })?.status).toBe('spam')
    expect(normaliseTicketRow({ id: 3, status: 'open' })?.status).toBe('open')
    expect(normaliseTicketRow({ id: 4, status: 'closed' })?.status).toBe('closed')
  })
})

describe('extractTicketLabels', () => {
  it('reads label objects and plain strings, deduped', () => {
    expect(
      extractTicketLabels([{ name: 'GCSE' }, 'Billing', { name: 'GCSE' }, ' Billing']),
    ).toEqual(['GCSE', 'Billing'])
  })

  it('returns [] for missing/odd shapes', () => {
    expect(extractTicketLabels(undefined)).toEqual([])
    expect(extractTicketLabels('GCSE')).toEqual([])
    expect(extractTicketLabels([null, 42, { id: 1 }])).toEqual([])
  })
})

describe('buildUserNameMap', () => {
  it('prefers full_name, then name, then first+last, then email', () => {
    const map = buildUserNameMap([
      { id: 1, full_name: 'Hamzah Khan', first_name: 'H', last_name: 'K' },
      { id: 2, name: 'Ops Bot' },
      { id: 3, first_name: 'Aisha', last_name: 'Begum' },
      { id: 4, email: 'agent@studymind.co.uk' },
    ])
    expect(map).toEqual({
      '1': 'Hamzah Khan',
      '2': 'Ops Bot',
      '3': 'Aisha Begum',
      '4': 'agent@studymind.co.uk',
    })
  })

  it('skips rows without a numeric id or any name', () => {
    expect(buildUserNameMap([{ full_name: 'No Id' }, { id: 9 }, null, 'x'])).toEqual({})
  })
})

describe('extractTicketAssigneeId', () => {
  it('reads the assignee however the listing spells it', () => {
    expect(extractTicketAssigneeId({ assignee_id: 7 })).toBe(7)
    expect(extractTicketAssigneeId({ user_id: '12' })).toBe(12)
    expect(extractTicketAssigneeId({ agent: { id: 9 } })).toBe(9)
    expect(extractTicketAssigneeId({ user: { id: 3, name: 'L' } })).toBe(3)
  })
  it('returns null when unassigned', () => {
    expect(extractTicketAssigneeId({})).toBeNull()
    expect(extractTicketAssigneeId({ user: {} })).toBeNull()
  })
})

describe('ticketWithinWindow', () => {
  const from = new Date('2026-01-01T00:00:00Z')

  it('keeps tickets inside the window and drops older ones', () => {
    expect(ticketWithinWindow(new Date('2026-02-01T00:00:00Z'), from)).toBe(true)
    expect(ticketWithinWindow(new Date('2025-12-31T23:59:59Z'), from)).toBe(false)
  })

  it('fails open when created_at was unparseable', () => {
    expect(ticketWithinWindow(null, from)).toBe(true)
  })
})

describe('listTicketsPage', () => {
  const ticketsResponse = {
    data: [{ id: 1 }],
    meta: { last_page: 2, total: 60 },
  }

  it('uses the documented /tickets listing first', async () => {
    const request = vi.fn(async () => ticketsResponse)
    const res = await listTicketsPage(request as never, 1, null, '2026-01-01')
    expect(res.endpoint).toBe('tickets')
    expect(res.rows).toEqual([{ id: 1 }])
    expect(res.hasNext).toBe(true)
    expect(res.total).toBe(60)
    expect(request).toHaveBeenCalledWith('GET', '/tickets?page=1&per_page=50')
  })

  it('falls back to the legacy /conversations path on a 404 when undecided', async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.startsWith('/tickets')) {
        throw new TrengoApiError(404, path, null)
      }
      return { data: [{ id: 2 }], meta: { last_page: 1 } }
    })
    const res = await listTicketsPage(request as never, 1, null, '2026-01-01')
    expect(res.endpoint).toBe('conversations')
    expect(res.rows).toEqual([{ id: 2 }])
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/conversations?created_at_after=2026-01-01&page=1&per_page=50',
    )
  })

  it('stays sticky once an endpoint is decided', async () => {
    const request = vi.fn(async () => ({ data: [], meta: {} }))
    await listTicketsPage(request as never, 2, 'conversations', '2026-01-01')
    expect(request).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/conversations?created_at_after=2026-01-01&page=2&per_page=50',
    )
  })

  it('propagates a 404 once /tickets has been pinned (no silent flip mid-run)', async () => {
    const request = vi.fn(async (_m: string, path: string) => {
      throw new TrengoApiError(404, path, null)
    })
    await expect(
      listTicketsPage(request as never, 2, 'tickets', '2026-01-01'),
    ).rejects.toBeInstanceOf(TrengoApiError)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('propagates non-fallback errors (auth, 5xx) without retrying a different shape', async () => {
    const request = vi.fn(async (_m: string, path: string) => {
      throw new TrengoApiError(401, path, null)
    })
    await expect(
      listTicketsPage(request as never, 1, null, '2026-01-01'),
    ).rejects.toBeInstanceOf(TrengoApiError)
    expect(request).toHaveBeenCalledTimes(1)
  })
})
