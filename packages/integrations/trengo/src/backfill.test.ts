// Tests for the Trengo historic-import parsing + fetch layer (ADR 0017).
//
// The Inngest function itself is orchestration (paging + DB writes) and is
// exercised against staging; what we pin here is the part that broke in the
// field — the listing endpoint (documented `/tickets`, with the legacy
// `/conversations` fallback), the pagination contract, and the defensive
// parsing of ticket/message rows whose shapes vary across Trengo versions.

import { describe, expect, it, vi } from 'vitest'

import {
  extractMessageBody,
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
    })
    expect(t).toEqual({
      id: 9,
      channel: 'whatsapp',
      status: 'open',
      subject: 'Re: trial lesson',
      contact: { phone: '+447700900123', email: 'parent@example.com', name: 'Jo Smith' },
      createdAt: new Date('2026-05-30T10:00:00.000Z'),
    })
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
