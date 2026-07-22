// Authenticated REST client for booking.studymind.co.uk (student-centric, ADR 0029).
//
// Pull is incremental and keyset-paginated (docs/api/booking-pull-api.md): each
// list call asks "what changed since X?" and walks an opaque cursor. We use
// plain `fetch` (no SDK) — the surface is small and we want retry/idempotency
// semantics in our hands — through `safeFetch` so the SSRF allowlist applies
// (CLAUDE.md §44.2; the host is already allowlisted).

import { safeFetch } from '@studymind/core/observability/safe-fetch'

import {
  mapCreditTransaction,
  mapHoursTransaction,
  mapLesson,
  mapStudent,
  type BookingCreditTxnResource,
  type BookingHoursTxnResource,
  type BookingLessonResource,
  type BookingStudent,
  type Page,
  type RawBalanceTransaction,
  type RawCreditTransaction,
  type RawLesson,
  type RawStudent,
} from './types'

export interface BookingClientOptions {
  apiToken?: string
  baseUrl?: string
  /** Override for tests. Defaults to the SSRF-guarded global fetch. */
  fetchImpl?: typeof fetch
}

/** Incremental list query. `cursor` (mid-walk) takes precedence over
 *  `updatedSince` (high-water mark) when both are present. */
export interface PullQuery {
  updatedSince: Date | null
  cursor: string | null
  limit?: number
}

export interface BookingClient {
  readonly baseUrl: string
  listStudents(q: PullQuery): Promise<Page<BookingStudent>>
  listLessons(q: PullQuery): Promise<Page<BookingLessonResource>>
  listBalanceTransactions(q: PullQuery): Promise<Page<BookingHoursTxnResource>>
  listCreditTransactions(q: PullQuery): Promise<Page<BookingCreditTxnResource>>
  getStudent(uuid: string): Promise<BookingStudent>
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

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 500

/** True when the booking pull is configured to run. The recurring jobs no-op
 *  (rather than throw every cron tick) when this is false, so the integration
 *  is safe to ship before the booking team exposes the API. */
export function isConfigured(): boolean {
  return Boolean(process.env['BOOKING_API_TOKEN'])
}

let cached: { client: BookingClient; key: string } | null = null

/**
 * Create (or return the cached) Booking site client. Reads `BOOKING_API_TOKEN`
 * and `BOOKING_API_BASE_URL` from env.
 */
export function createClient(opts: BookingClientOptions = {}): BookingClient {
  const apiToken = opts.apiToken ?? process.env['BOOKING_API_TOKEN']
  if (!apiToken) {
    throw new Error('BOOKING_API_TOKEN is not set')
  }
  const baseUrl = normaliseBaseUrl(
    opts.baseUrl ?? process.env['BOOKING_API_BASE_URL'] ?? 'https://booking.studymind.co.uk/api/v1',
  )
  const fetchImpl = opts.fetchImpl ?? safeFetch
  const cacheKey = `${apiToken}|${baseUrl}`
  if (cached && cached.key === cacheKey && !opts.fetchImpl) return cached.client

  function buildQuery(q: PullQuery): string {
    const params = new URLSearchParams()
    const limit = Math.min(q.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    params.set('limit', String(limit))
    // A live cursor walk takes precedence; the server encodes both position and
    // the original `updated_since` inside it (docs/api/booking-pull-api.md §2.5).
    if (q.cursor) {
      params.set('cursor', q.cursor)
    } else if (q.updatedSince) {
      params.set('updated_since', q.updatedSince.toISOString())
    }
    return params.toString()
  }

  async function requestPage<TRaw, TDomain>(
    resource: string,
    q: PullQuery,
    map: (raw: TRaw) => TDomain,
  ): Promise<Page<TDomain>> {
    const path = `/${resource}?${buildQuery(q)}`
    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${apiToken}`,
    }
    // Cheap polls: ask the site to 304 when nothing changed since the
    // high-water mark (docs/api/booking-pull-api.md §2.7).
    if (!q.cursor && q.updatedSince) {
      headers['If-Modified-Since'] = q.updatedSince.toUTCString()
    }

    const res = await fetchImpl(`${baseUrl}${path}`, { headers })
    if (res.status === 304) {
      return { data: [], nextCursor: null, hasMore: false }
    }
    if (!res.ok) {
      throw new BookingApiError(res.status, path, await readBody(res))
    }
    const json = (await res.json()) as {
      data?: TRaw[]
      next_cursor?: string | null
      has_more?: boolean
    }
    const raw = json.data ?? []
    // Map defensively — a single row with an unknown enum / malformed required
    // date makes the mapper throw (fail-closed, §8). Skip THAT row rather than
    // rejecting the whole page: an eager `raw.map(map)` let one poison row throw
    // the drain, so its `step.run` retried and failed forever and the keyset
    // cursor never advanced — freezing the entire resource's sync indefinitely.
    const mapped: TDomain[] = []
    let skipped = 0
    for (const item of raw) {
      try {
        mapped.push(map(item))
      } catch {
        skipped += 1
      }
    }
    return {
      data: mapped,
      nextCursor: json.next_cursor ?? null,
      hasMore: json.has_more ?? false,
      skipped,
    }
  }

  async function requestOne<TRaw, TDomain>(
    path: string,
    key: string,
    map: (raw: TRaw) => TDomain,
  ): Promise<TDomain> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
    })
    if (!res.ok) throw new BookingApiError(res.status, path, await readBody(res))
    const json = (await res.json()) as Record<string, TRaw>
    const raw = json[key]
    if (!raw) throw new BookingApiError(res.status, path, json)
    return map(raw)
  }

  const client: BookingClient = {
    baseUrl,
    listStudents: (q) => requestPage<RawStudent, BookingStudent>('students', q, mapStudent),
    listLessons: (q) => requestPage<RawLesson, BookingLessonResource>('lessons', q, mapLesson),
    listBalanceTransactions: (q) =>
      requestPage<RawBalanceTransaction, BookingHoursTxnResource>(
        'balance-transactions',
        q,
        mapHoursTransaction,
      ),
    listCreditTransactions: (q) =>
      requestPage<RawCreditTransaction, BookingCreditTxnResource>(
        'credit-transactions',
        q,
        mapCreditTransaction,
      ),
    getStudent: (uuid) =>
      requestOne<RawStudent, BookingStudent>(
        `/students/${encodeURIComponent(uuid)}`,
        'student',
        mapStudent,
      ),
  }

  if (!opts.fetchImpl) cached = { client, key: cacheKey }
  return client
}

function normaliseBaseUrl(raw: string): string {
  return raw.replace(/\/+$/u, '')
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return await res.text().catch(() => null)
  }
}

/** Reset the cached client. Tests only. */
export function __resetClientForTests(): void {
  cached = null
}
