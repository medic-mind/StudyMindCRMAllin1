// Pure filtering for the CRM's Summer Camp bookings workspace. The camp feed
// has no server-side search, so the router pulls the (bounded) live feed and
// filters here — kept pure + unit-tested per CLAUDE.md §30.

import type { BookingResource } from './types'

export interface BookingsFilter {
  /** Case-insensitive match on student / guardian name, email, camp, subject. */
  search?: string | null
  status?: string | null
  campId?: string | null
  weekNumber?: number | null
  /** Only bookings with no camp assigned (and not cancelled). */
  unassigned?: boolean
}

function bookedWeekNumbers(b: BookingResource): number[] {
  const weeks: number[] = []
  if (typeof b.week_number === 'number') weeks.push(b.week_number)
  for (const raw of b.booked_weeks ?? []) {
    if (raw && typeof raw === 'object' && 'week_number' in raw) {
      const n = (raw as { week_number?: unknown }).week_number
      if (typeof n === 'number') weeks.push(n)
    }
  }
  return weeks
}

function searchHaystack(b: BookingResource): string {
  return [
    b.student?.first_name,
    b.student?.last_name,
    b.student?.email,
    b.guardian?.name,
    b.guardian?.email,
    b.camp_name,
    b.subject,
    b.agent_name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

export function bookingMatchesFilter(b: BookingResource, filter: BookingsFilter): boolean {
  if (filter.status && b.status !== filter.status) return false
  if (filter.unassigned && (b.camp_id || b.status === 'cancelled')) return false
  if (filter.campId) {
    const enrolled = b.enrolled_camp_ids ?? (b.camp_id ? [b.camp_id] : [])
    if (!enrolled.includes(filter.campId)) return false
  }
  if (typeof filter.weekNumber === 'number' && !bookedWeekNumbers(b).includes(filter.weekNumber)) {
    return false
  }
  const q = filter.search?.trim().toLowerCase()
  if (q && !searchHaystack(b).includes(q)) return false
  return true
}

export function filterBookings(bookings: BookingResource[], filter: BookingsFilter): BookingResource[] {
  return bookings.filter((b) => bookingMatchesFilter(b, filter))
}
