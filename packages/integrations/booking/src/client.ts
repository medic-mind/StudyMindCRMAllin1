// Authenticated REST client for booking.studymind.co.uk.
//
// CLAUDE.md §15 — sync is pull-based today (every 5 min for active families,
// hourly for inactive). Use `If-Modified-Since` on every list call to be
// polite to the booking site.
//
// We use plain `fetch` (no SDK) — the surface is small and we want signature
// verification, idempotency, and retry semantics in our hands.

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import {
  mapBooking,
  mapBookingSession,
  mapFamily,
  type BookingFamilyRef,
  type BookingResource,
  type BookingSessionResource,
  type RawBooking,
  type RawBookingFamily,
  type RawBookingSession,
} from './types'

export interface BookingClientOptions {
  apiToken?: string
  baseUrl?: string
  /** Override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export interface BookingClient {
  readonly baseUrl: string
  listFamiliesChangedSince(since: Date): Promise<BookingFamilyRef[]>
  listBookingsForFamily(externalFamilyId: string, since: Date): Promise<BookingResource[]>
  listSessionsForBooking(externalBookingId: string, since: Date): Promise<BookingSessionResource[]>
  getBookingSession(sessionId: string): Promise<BookingSessionResource>
}

export class BookingApiError extends Error {
  override readonly name = 'BookingApiError'
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: unknown,
  ) {
    super(`Booking site ${status} on ${path}`)
  }
}

let cached: { client: BookingClient; key: string } | null = null

/**
 * Create (or return the cached) Booking site client. Reads
 * `BOOKING_API_TOKEN` and `BOOKING_API_BASE_URL` from env.
 */
export function createClient(opts: BookingClientOptions = {}): BookingClient {
  const apiToken = opts.apiToken ?? process.env['BOOKING_API_TOKEN']
  if (!apiToken) {
    throw new Error('BOOKING_API_TOKEN is not set')
  }
  const baseUrl =
    opts.baseUrl ?? process.env['BOOKING_API_BASE_URL'] ?? 'https://booking.studymind.co.uk'
  const fetchImpl = opts.fetchImpl ?? safeFetch
  const cacheKey = `${apiToken}|${baseUrl}`
  if (cached && cached.key === cacheKey && !opts.fetchImpl) return cached.client

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = `${baseUrl}${path}`
    const res = await fetchImpl(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiToken}`,
        ...(init.headers ?? {}),
      },
    })
    if (!res.ok) {
      let body: unknown = null
      try {
        body = await res.json()
      } catch {
        body = await res.text().catch(() => null)
      }
      throw new BookingApiError(res.status, path, body)
    }
    return (await res.json()) as T
  }

  function ifModifiedSinceHeaders(since: Date): HeadersInit {
    return { 'If-Modified-Since': since.toUTCString() }
  }

  const client: BookingClient = {
    baseUrl,
    async listFamiliesChangedSince(since) {
      const data = await request<{ families: RawBookingFamily[] }>(
        `/api/v1/families?since=${encodeURIComponent(since.toISOString())}`,
        { headers: ifModifiedSinceHeaders(since) },
      )
      return data.families.map(mapFamily)
    },
    async listBookingsForFamily(externalFamilyId, since) {
      const data = await request<{ bookings: RawBooking[] }>(
        `/api/v1/families/${encodeURIComponent(externalFamilyId)}/bookings?since=${encodeURIComponent(since.toISOString())}`,
        { headers: ifModifiedSinceHeaders(since) },
      )
      return data.bookings.map(mapBooking)
    },
    async listSessionsForBooking(externalBookingId, since) {
      const data = await request<{ sessions: RawBookingSession[] }>(
        `/api/v1/bookings/${encodeURIComponent(externalBookingId)}/sessions?since=${encodeURIComponent(since.toISOString())}`,
        { headers: ifModifiedSinceHeaders(since) },
      )
      return data.sessions.map(mapBookingSession)
    },
    async getBookingSession(sessionId) {
      const data = await request<{ session: RawBookingSession }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}`,
      )
      return mapBookingSession(data.session)
    },
  }

  if (!opts.fetchImpl) cached = { client, key: cacheKey }
  return client
}

/** Reset the cached client. Tests only. */
export function __resetClientForTests(): void {
  cached = null
}
