// Domain-mapped types for the StudyMind booking site.
// CLAUDE.md §6.4 — booking states: tentative | confirmed | delivered | no_show | cancelled.
// CLAUDE.md §15 — booking site is the source of truth for hours.
// We never let raw booking-site types leak into the rest of the app; this
// module owns the mappers and fails closed on unknown values.

export type BookingState = 'tentative' | 'confirmed' | 'delivered' | 'no_show' | 'cancelled'

const BOOKING_STATES: ReadonlySet<BookingState> = new Set([
  'tentative',
  'confirmed',
  'delivered',
  'no_show',
  'cancelled',
])

/**
 * Map a raw booking-site state string into our domain enum. Fails closed on
 * unknown values rather than silently coercing — new states must be added
 * explicitly (CLAUDE.md §19, fail-closed pattern).
 */
export function mapBookingState(raw: string): BookingState {
  const normalised = raw.toLowerCase().replace(/[\s-]/g, '_')
  if (BOOKING_STATES.has(normalised as BookingState)) {
    return normalised as BookingState
  }
  throw new Error(`Unknown booking state from provider: ${raw}`)
}

export interface BookingFamilyRef {
  externalFamilyId: string
  /** Our internal Family.id, if the booking site has been told about it. */
  crmFamilyId?: string | null
  updatedAt: Date
}

export interface BookingResource {
  externalId: string
  externalFamilyId: string
  state: BookingState
  contractedHours: number
  updatedAt: Date
}

export interface BookingSessionResource {
  externalId: string
  externalBookingId: string
  scheduledAt: Date
  state: BookingState
  /** Hours contracted for this session, set at creation. */
  contractedHours: number
  /** Hours scheduled for this session — equal to contracted unless rescheduled. */
  scheduledHours: number
  /** Hours actually delivered. Only meaningful when state === 'delivered'. */
  deliveredHours: number
  /** If this session is a correction of an earlier delivered session, points to it. */
  correctedExternalSessionId?: string | null
  updatedAt: Date
}

// -----------------------------------------------------------------------------
// Raw API shape (internal). We deliberately keep these tight — the booking
// site is ours and additive changes should bump a documented schema rather
// than silently widen this type.
// -----------------------------------------------------------------------------

export interface RawBookingFamily {
  id: string
  crm_family_id?: string | null
  updated_at: string
}

export interface RawBooking {
  id: string
  family_id: string
  state: string
  contracted_hours: number
  updated_at: string
}

export interface RawBookingSession {
  id: string
  booking_id: string
  scheduled_at: string
  state: string
  contracted_hours: number
  scheduled_hours: number
  delivered_hours: number
  corrected_session_id?: string | null
  updated_at: string
}

export function mapFamily(raw: RawBookingFamily): BookingFamilyRef {
  return {
    externalFamilyId: raw.id,
    crmFamilyId: raw.crm_family_id ?? null,
    updatedAt: new Date(raw.updated_at),
  }
}

export function mapBooking(raw: RawBooking): BookingResource {
  return {
    externalId: raw.id,
    externalFamilyId: raw.family_id,
    state: mapBookingState(raw.state),
    contractedHours: raw.contracted_hours,
    updatedAt: new Date(raw.updated_at),
  }
}

export function mapBookingSession(raw: RawBookingSession): BookingSessionResource {
  return {
    externalId: raw.id,
    externalBookingId: raw.booking_id,
    scheduledAt: new Date(raw.scheduled_at),
    state: mapBookingState(raw.state),
    contractedHours: raw.contracted_hours,
    scheduledHours: raw.scheduled_hours,
    deliveredHours: raw.delivered_hours,
    correctedExternalSessionId: raw.corrected_session_id ?? null,
    updatedAt: new Date(raw.updated_at),
  }
}
