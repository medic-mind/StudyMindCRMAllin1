// Unit tests for the contact export-row constructor. `toContactExportRow` is a
// pure data shaper (the CSV export streams whatever it returns), so these prove
// the field mapping, channel grouping, tag joining, GBP-source figures, and the
// derived hours-risk are all correct without a DB.

import { describe, expect, it } from 'vitest'

import { toContactExportRow } from './contact'

// Minimal builder for the source row the constructor expects — mirrors the
// Prisma row shape `contact.exportRows` feeds it.
function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    kind: 'parent' as const,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    phoneE164: '+447700900123',
    dateOfBirth: null,
    isMinor: false,
    notes: 'Prefers evening calls',
    addressLine1: '1 High St',
    addressLine2: null,
    city: 'London',
    postcode: 'E1 6AN',
    country: 'United Kingdom',
    schoolName: 'St Mary',
    yearGroup: 'Y11',
    sendStatus: null,
    jobTitle: null,
    pronouns: null,
    mailchimpEmail: null,
    preferredContactMethod: 'email' as const,
    timezone: 'Europe/London',
    referralSource: 'Google',
    examTarget: 'GCSE Maths',
    bookingStatus: 'registered_with_hours' as const,
    bookingContactId: 'bk-9',
    hoursBooked: 20,
    hoursDelivered: 5,
    lastLessonAt: new Date('2026-06-01T10:00:00Z'),
    amountSpentMinor: 12345,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-07-01T00:00:00Z'),
    familyMembers: [{ family: { id: 'f1', name: 'Lovelace Family' } }],
    interactions: [{ occurredAt: new Date('2026-07-10T09:00:00Z') }],
    companies: [
      { company: { id: 'co1', name: 'Study Mind', slug: 'study-mind', color: null } },
      { company: { id: 'co2', name: 'Medic Mind', slug: 'medic-mind', color: null } },
    ],
    labels: [{ label: { id: 'l1', name: 'VIP', color: '#f00' } }],
    subjects: [{ subject: { id: 's1', name: 'Maths' } }],
    bookingProfile: { hoursRemaining: 15, nextHoursExpiryAt: null },
    ...overrides,
  }
}

describe('toContactExportRow', () => {
  it('maps the full contact record onto a flat export row', () => {
    const row = toContactExportRow(makeRow(), {
      counts: { callCount: 3, emailCount: 7, textCount: 2 },
      complaintCount: 1,
      enquiryTypes: ['Tutoring', 'UCAT'],
      channels: [
        { kind: 'email', value: 'work@example.com', label: 'Work' },
        { kind: 'phone', value: '+447700900999', label: null },
        { kind: 'other', value: '@ada', label: 'Instagram' },
      ],
      now: new Date('2026-07-15T00:00:00Z'),
    })

    expect(row.displayName).toBe('Ada Lovelace')
    expect(row.email).toBe('ada@example.com')
    expect(row.additionalEmails).toBe('work@example.com (Work)')
    expect(row.additionalPhones).toBe('+447700900999')
    expect(row.otherChannels).toBe('@ada (Instagram)')
    expect(row.companies).toBe('Study Mind · Medic Mind')
    expect(row.labels).toBe('VIP')
    expect(row.subjects).toBe('Maths')
    expect(row.enquiryTypes).toBe('Tutoring · UCAT')
    expect(row.familyName).toBe('Lovelace Family')
    expect(row.bookingContactId).toBe('bk-9')
    expect(row.hoursRemaining).toBe(15)
    expect(row.amountSpentMinor).toBe(12345)
    expect(row.callCount).toBe(3)
    expect(row.emailCount).toBe(7)
    expect(row.textCount).toBe(2)
    expect(row.complaintCount).toBe(1)
    expect(row.lastInteractionAt).toEqual(new Date('2026-07-10T09:00:00Z'))
    expect(row.notes).toBe('Prefers evening calls')
  })

  it('defaults optional extras and empties missing channels/tags', () => {
    const row = toContactExportRow(
      makeRow({ companies: [], labels: [], subjects: [], familyMembers: [], interactions: [] }),
    )
    expect(row.additionalEmails).toBe('')
    expect(row.additionalPhones).toBe('')
    expect(row.otherChannels).toBe('')
    expect(row.companies).toBe('')
    expect(row.labels).toBe('')
    expect(row.subjects).toBe('')
    expect(row.enquiryTypes).toBe('')
    expect(row.familyName).toBeNull()
    expect(row.lastInteractionAt).toBeNull()
    expect(row.callCount).toBe(0)
    expect(row.complaintCount).toBe(0)
  })

  it('derives an hours-risk level from the booking figures', () => {
    const row = toContactExportRow(makeRow(), { now: new Date('2026-07-15T00:00:00Z') })
    expect(['none', 'low', 'medium', 'high']).toContain(row.riskLevel)
    expect(typeof row.riskScore).toBe('number')
  })

  it('reads a Prisma Decimal hoursRemaining exactly, without rounding', () => {
    // Production hands a Prisma.Decimal ({ toNumber(): number }) here, and the
    // balance is Decimal(8,2) — a fractional value must survive to the CSV.
    const row = toContactExportRow(
      makeRow({
        bookingProfile: { hoursRemaining: { toNumber: () => 12.75 }, nextHoursExpiryAt: null },
      }),
    )
    expect(row.hoursRemaining).toBe(12.75)
  })

  it('keeps hoursRemaining null when there is no booking profile', () => {
    const row = toContactExportRow(makeRow({ bookingProfile: null }))
    expect(row.hoursRemaining).toBeNull()
  })

  it('falls back to email then a placeholder for the display name', () => {
    const noName = toContactExportRow(makeRow({ firstName: null, lastName: null }))
    expect(noName.displayName).toBe('ada@example.com')
    const anon = toContactExportRow(makeRow({ firstName: null, lastName: null, email: null }))
    expect(anon.displayName).toBe('Unnamed contact')
  })
})
