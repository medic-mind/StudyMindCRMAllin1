import { createHmac } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { decideMatch, normalisePhone } from './apply'
import { verifyAndParse } from './webhook'
import { mapContactToBookingFields } from './writeback'

const SECRET = 'test-secret'

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body, 'utf8').digest('hex')
}

const validEnvelope = {
  id: 'b1:summer_camp.booking.created:1700000000000',
  type: 'summer_camp.booking.created',
  occurred_at: '2026-06-07T10:00:00.000Z',
  site: { url: 'https://camp.studymind.co.uk' },
  booking: {
    id: 'b1',
    status: 'confirmed',
    booking_type: 'b2c',
    camp_id: 'c1',
    camp_name: 'Oxford Summer Camp',
    subject: 'Maths',
    week_number: 1,
    week_label: 'Week 1',
    guardian: { name: 'Jane Doe', email: 'jane@example.com', mobile: '07700900123' },
    student: { first_name: 'Sam', last_name: 'Doe', email: null, mobile: null },
    payment: { total_minor: 50000, paid_minor: 25000, type: 'card', reference: null },
  },
}

describe('verifyAndParse', () => {
  it('accepts a correctly signed, well-formed envelope', () => {
    const body = JSON.stringify(validEnvelope)
    const result = verifyAndParse(body, sign(body), { webhookSecret: SECRET })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.envelope.booking.id).toBe('b1')
      expect(result.envelope.type).toBe('summer_camp.booking.created')
    }
  })

  it('rejects a bad signature', () => {
    const body = JSON.stringify(validEnvelope)
    const result = verifyAndParse(body, sign('tampered'), { webhookSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'signature_mismatch' })
  })

  it('rejects a missing signature', () => {
    expect(verifyAndParse('{}', null, { webhookSecret: SECRET })).toEqual({
      ok: false,
      reason: 'missing_signature',
    })
  })

  it('rejects when no secret is configured', () => {
    const body = JSON.stringify(validEnvelope)
    expect(verifyAndParse(body, sign(body), { webhookSecret: null })).toEqual({
      ok: false,
      reason: 'missing_secret',
    })
  })

  it('rejects a body that does not match the schema', () => {
    const body = JSON.stringify({ id: 'x', type: 'nope', booking: {} })
    const result = verifyAndParse(body, sign(body), { webhookSecret: SECRET })
    expect(result).toEqual({ ok: false, reason: 'invalid_body' })
  })
})

describe('normalisePhone', () => {
  it('keeps a valid E.164 number', () => {
    expect(normalisePhone('+447700900123')).toBe('+447700900123')
  })
  it('converts a UK 0-prefixed number', () => {
    expect(normalisePhone('07700 900123')).toBe('+447700900123')
  })
  it('converts a 00 international prefix', () => {
    expect(normalisePhone('0033123456789')).toBe('+33123456789')
  })
  it('returns null for junk', () => {
    expect(normalisePhone('n/a')).toBeNull()
    expect(normalisePhone('')).toBeNull()
    expect(normalisePhone(null)).toBeNull()
  })
})

describe('decideMatch', () => {
  it('adopts a single unambiguous match', () => {
    expect(decideMatch(['c1'])).toEqual({ use: 'c1' })
  })
  it('creates when there is no match', () => {
    expect(decideMatch([])).toEqual({ create: true })
  })
  it('creates (never merges) when ambiguous', () => {
    expect(decideMatch(['c1', 'c2'])).toEqual({ create: true })
  })
})

describe('mapContactToBookingFields (write-back)', () => {
  it('maps a student contact to student_* fields', () => {
    expect(
      mapContactToBookingFields({ kind: 'student', firstName: 'Sam', lastName: 'Doe', email: 's@x.com', phoneE164: '+44700' }),
    ).toEqual({
      student_first_name: 'Sam',
      student_last_name: 'Doe',
      student_email: 's@x.com',
      student_mobile: '+44700',
    })
  })
  it('maps a parent contact to guardian_* fields (name joined)', () => {
    expect(
      mapContactToBookingFields({ kind: 'parent', firstName: 'Jane', lastName: 'Doe', email: 'j@x.com', phoneE164: null }),
    ).toEqual({
      guardian_name: 'Jane Doe',
      guardian_email: 'j@x.com',
    })
  })
  it('omits empty fields', () => {
    expect(mapContactToBookingFields({ kind: 'student', firstName: null, lastName: null, email: null, phoneE164: null })).toEqual({})
  })
})
