// Client request-shaping tests (ADR 0029). We pin the wire contract — query
// params, headers, 304 handling, errors — with a fake fetch so the booking
// team and the CRM stay in step (docs/api/booking-pull-api.md).

import { afterEach, describe, expect, it, vi } from 'vitest'

import { BookingApiError, createClient, isConfigured, __resetClientForTests } from './client'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

const ONE_STUDENT = {
  data: [
    {
      uuid: 'u-1',
      id: 1,
      full_name: 'Test Student',
      updated_at: '2026-05-30T09:00:00Z',
      created_at: '2020-01-01T00:00:00Z',
    },
  ],
  next_cursor: 'CURSOR2',
  has_more: true,
}

afterEach(() => __resetClientForTests())

describe('isConfigured', () => {
  it('reflects BOOKING_API_TOKEN', () => {
    const prev = process.env['BOOKING_API_TOKEN']
    delete process.env['BOOKING_API_TOKEN']
    expect(isConfigured()).toBe(false)
    process.env['BOOKING_API_TOKEN'] = 'tok'
    expect(isConfigured()).toBe(true)
    if (prev === undefined) delete process.env['BOOKING_API_TOKEN']
    else process.env['BOOKING_API_TOKEN'] = prev
  })
})

describe('listStudents request shaping', () => {
  it('sends updated_since + limit + auth + If-Modified-Since on a fresh poll', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(ONE_STUDENT)) as unknown as typeof fetch
    const client = createClient({
      apiToken: 'tok',
      baseUrl: 'https://booking.example/api/v1',
      fetchImpl,
    })

    const page = await client.listStudents({
      updatedSince: new Date('2026-05-01T00:00:00Z'),
      cursor: null,
    })

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('/students?')
    expect(String(url)).toContain('updated_since=2026-05-01T00%3A00%3A00.000Z')
    expect(String(url)).toContain('limit=200')
    expect(String(url)).not.toContain('cursor=')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['Authorization']).toBe('Bearer tok')
    expect(headers['If-Modified-Since']).toBeTruthy()

    expect(page.data).toHaveLength(1)
    expect(page.data[0]!.uuid).toBe('u-1')
    expect(page.nextCursor).toBe('CURSOR2')
    expect(page.hasMore).toBe(true)
  })

  it('walks by cursor (no updated_since / If-Modified-Since) and caps the limit', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [], next_cursor: null, has_more: false }),
    ) as unknown as typeof fetch
    const client = createClient({
      apiToken: 'tok',
      baseUrl: 'https://booking.example/api/v1',
      fetchImpl,
    })

    await client.listStudents({
      updatedSince: new Date('2026-05-01T00:00:00Z'),
      cursor: 'CUR',
      limit: 9999,
    })

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(String(url)).toContain('cursor=CUR')
    expect(String(url)).not.toContain('updated_since=')
    expect(String(url)).toContain('limit=500')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers['If-Modified-Since']).toBeUndefined()
  })
})

describe('error + 304 handling', () => {
  it('treats 304 as an empty drained page', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(null, { status: 304 }),
    ) as unknown as typeof fetch
    const client = createClient({
      apiToken: 'tok',
      baseUrl: 'https://booking.example/api/v1',
      fetchImpl,
    })
    const page = await client.listLessons({
      updatedSince: new Date('2026-05-01T00:00:00Z'),
      cursor: null,
    })
    expect(page).toEqual({ data: [], nextCursor: null, hasMore: false })
  })

  it('throws BookingApiError on a non-2xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'boom' } }, 500),
    ) as unknown as typeof fetch
    const client = createClient({
      apiToken: 'tok',
      baseUrl: 'https://booking.example/api/v1',
      fetchImpl,
    })
    await expect(
      client.listCreditTransactions({ updatedSince: null, cursor: null }),
    ).rejects.toBeInstanceOf(BookingApiError)
  })
})
