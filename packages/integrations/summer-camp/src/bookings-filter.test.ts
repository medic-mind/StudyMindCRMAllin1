import { describe, expect, it } from 'vitest'

import { filterBookings } from './bookings-filter'
import type { BookingResource } from './types'

function booking(overrides: Partial<BookingResource>): BookingResource {
  return {
    id: 'b1',
    status: 'confirmed',
    booking_type: 'b2c',
    camp_id: 'camp-a',
    camp_name: 'Oxford Summer Camp',
    subject: 'Maths',
    week_number: 1,
    booked_weeks: [],
    student: {
      first_name: 'Test',
      last_name: 'Student',
      email: 'student@example.test',
      mobile: null,
      name: null,
      dietary_requirements: null,
      medical_notes: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
    },
    guardian: { name: 'Test Guardian', email: 'guardian@example.test', mobile: null, first_name: null, last_name: null },
    payment: { total_minor: 50000, paid_minor: 25000, type: 'card', reference: null },
    ...overrides,
  } as BookingResource
}

describe('filterBookings', () => {
  it('matches search across student, guardian, camp and subject', () => {
    const rows = [booking({ id: 'b1' }), booking({ id: 'b2', subject: 'Physics', camp_name: 'Leeds Camp' })]
    expect(filterBookings(rows, { search: 'oxford' }).map((b) => b.id)).toEqual(['b1'])
    expect(filterBookings(rows, { search: 'PHYSICS' }).map((b) => b.id)).toEqual(['b2'])
    expect(filterBookings(rows, { search: 'guardian@example' })).toHaveLength(2)
  })

  it('filters by status and by camp (including multi-camp enrolments)', () => {
    const rows = [
      booking({ id: 'b1', status: 'pending' }),
      booking({ id: 'b2', camp_id: 'camp-b', enrolled_camp_ids: ['camp-b', 'camp-a'] }),
    ]
    expect(filterBookings(rows, { status: 'pending' }).map((b) => b.id)).toEqual(['b1'])
    // b1 is on camp-a directly; b2 is enrolled in camp-a as a secondary camp.
    expect(filterBookings(rows, { campId: 'camp-a' }).map((b) => b.id)).toEqual(['b1', 'b2'])
    expect(filterBookings(rows, { campId: 'camp-b' }).map((b) => b.id)).toEqual(['b2'])
  })

  it('filters by week across single and multi-week bookings', () => {
    const rows = [
      booking({ id: 'b1', week_number: 1 }),
      booking({ id: 'b2', week_number: 2, booked_weeks: [{ week_number: 3 }] }),
    ]
    expect(filterBookings(rows, { weekNumber: 3 }).map((b) => b.id)).toEqual(['b2'])
    expect(filterBookings(rows, { weekNumber: 1 }).map((b) => b.id)).toEqual(['b1'])
  })

  it('unassigned means no camp and not cancelled', () => {
    const rows = [
      booking({ id: 'b1', camp_id: null, camp_name: null }),
      booking({ id: 'b2', camp_id: null, camp_name: null, status: 'cancelled' }),
      booking({ id: 'b3' }),
    ]
    expect(filterBookings(rows, { unassigned: true }).map((b) => b.id)).toEqual(['b1'])
  })
})
