// Read-only client for the Summer Camp app's `/api/external/*` feeds. Powers
// the CRM's live, view-only "Summer Camps" surface (roster + fill + weekly
// timetables) for the sales team. Authenticated with a shared bearer token.
//
// Config is env-only (no secrets table): SUMMER_CAMP_API_URL + the read key in
// SUMMER_CAMP_API_KEY. When unset, the feeds are simply unavailable and the
// caller renders a "not connected" state — never a 500.

export interface SummerCampConfig {
  baseUrl: string
  apiKey: string
}

export interface FillCounts {
  total: number
  confirmed: number
  pending: number
  waitlist: number
  b2c: number
  b2b: number
  agent: number
}

export interface CampSummary {
  id: string
  name: string
  location: string | null
  start_date: string | null
  end_date: string | null
  status: string | null
  template_letter: string | null
  bookings: FillCounts
}

export interface WeekMeta {
  week_number: number
  week_label: string
  start_date: string | null
  end_date: string | null
  template_letter: string
}

export interface CampsFeed {
  year: number
  camps: CampSummary[]
  weeks: WeekMeta[]
  subjects: string[]
  grid: Record<string, Record<string, FillCounts>>
  totals: { byWeek: Record<string, number>; bySubject: Record<string, number>; grand: number }
}

export interface TimetableEntry {
  start_time: string | null
  end_time: string | null
  title: string | null
  subject: string | null
  tutor: string | null
  location: string | null
  room_number: string | null
  session_type: string | null
  session_colour: string | null
  session_icon: string | null
  is_field_trip: boolean
  what_to_bring: string | null
}

export interface TimetableDay {
  id: string
  date: string | null
  day_number: number | null
  label: string | null
  entries: TimetableEntry[]
}

export interface TimetableCamp {
  id: string
  name: string
  location: string | null
  start_date: string | null
  end_date: string | null
  status: string | null
  arrival_location: string | null
  arrival_time: string | null
  arrival_notes: string | null
  arrival_bring: string | null
  days: TimetableDay[]
}

export interface TimetableFeed {
  camps: TimetableCamp[]
}

export interface BookingsPage {
  /** Each item is the normalised booking shape (parse with BookingResource). */
  bookings: unknown[]
  nextCursor: string | null
}

export interface GetBookingsOpts {
  /** ISO timestamp — only bookings updated at/after this time (incremental). */
  since?: string | null
  /** Opaque keyset cursor from a previous page (full backfill walk). */
  cursor?: string | null
  limit?: number
}

/** Resolve config from env. Returns null when not configured. */
export function loadSummerCampConfig(): SummerCampConfig | null {
  const baseUrl = process.env['SUMMER_CAMP_API_URL']
  const apiKey = process.env['SUMMER_CAMP_API_KEY']
  if (!baseUrl || !apiKey) return null
  return { baseUrl: baseUrl.replace(/\/$/, ''), apiKey }
}

export class SummerCampClient {
  constructor(private readonly config: SummerCampConfig) {}

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.config.apiKey}` },
      // Always hit the live app; the CRM page controls caching at its layer.
      cache: 'no-store',
    })
    if (!res.ok) {
      throw new Error(`summer-camp feed ${path} failed: ${res.status}`)
    }
    return (await res.json()) as T
  }

  getCamps(year?: number): Promise<CampsFeed> {
    const q = year ? `?year=${year}` : ''
    return this.get<CampsFeed>(`/api/external/camps${q}`)
  }

  getTimetable(campId?: string | null): Promise<TimetableFeed> {
    const q = campId ? `?camp_id=${encodeURIComponent(campId)}` : ''
    return this.get<TimetableFeed>(`/api/external/timetable${q}`)
  }

  /** One keyset page of bookings for the CRM's backfill + periodic sync. */
  getBookings(opts: GetBookingsOpts = {}): Promise<BookingsPage> {
    const p = new URLSearchParams()
    if (opts.since) p.set('since', opts.since)
    if (opts.cursor) p.set('cursor', opts.cursor)
    if (opts.limit) p.set('limit', String(opts.limit))
    const qs = p.toString()
    return this.get<BookingsPage>(`/api/external/bookings${qs ? `?${qs}` : ''}`)
  }

  private async write(path: string, method: 'POST' | 'PATCH' | 'PUT', body: unknown): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const res = await fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const parsed: unknown = await res.json().catch(() => null)
      if (!res.ok) {
        const detail =
          parsed && typeof parsed === 'object' && 'error' in parsed && typeof parsed.error === 'string'
            ? `: ${parsed.error}`
            : ''
        throw new Error(`summer-camp ${method} ${path} failed: ${res.status}${detail}`)
      }
      return parsed
    } finally {
      clearTimeout(timer)
    }
  }

  /** Write-back: add a note to a camp booking. Returns the camp's note id so
   *  the CRM can store it as the dedupe key for feed round-trips. */
  async postNote(bookingId: string, body: string, author?: string | null): Promise<string | null> {
    const out = await this.write(`/api/external/bookings/${encodeURIComponent(bookingId)}/notes`, 'POST', {
      body,
      author: author ?? null,
    })
    if (out && typeof out === 'object' && 'note' in out) {
      const note = (out as { note?: { id?: unknown } }).note
      if (note && typeof note.id === 'string') return note.id
    }
    return null
  }

  /** Write-back: update whitelisted fields on a camp booking. */
  async patchBooking(bookingId: string, fields: Record<string, unknown>): Promise<void> {
    await this.write(`/api/external/bookings/${encodeURIComponent(bookingId)}`, 'PATCH', fields)
  }

  /** Write-back: assign the booking's student to camps (first id = primary).
   *  An empty array clears the assignment. */
  async putCampAssignment(bookingId: string, campIds: string[]): Promise<void> {
    await this.write(`/api/external/bookings/${encodeURIComponent(bookingId)}/camps`, 'PUT', {
      camp_ids: campIds,
    })
  }
}

/** Build a client from env, or null when the integration is not configured. */
export function createClientFromConfig(): SummerCampClient | null {
  const config = loadSummerCampConfig()
  return config ? new SummerCampClient(config) : null
}
