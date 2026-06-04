import { describe, expect, it } from 'vitest'

import {
  computeSessions,
  dueSessions,
  isHoliday,
  sendAtFor,
  sessionStartInstant,
  zonedWallTimeToUtc,
  zoomRotationDue,
} from './schedule'

const d = (s: string) => new Date(`${s}T00:00:00.000Z`)

describe('computeSessions', () => {
  it('lists weekly sessions on the right weekday and numbers them', () => {
    // 2026-09-01 is a Tuesday. dayOfWeek 1 = Tuesday.
    const sessions = computeSessions(d('2026-09-01'), d('2026-09-29'), 1)
    expect(sessions.map((s) => s.date.toISOString().slice(0, 10))).toEqual([
      '2026-09-01',
      '2026-09-08',
      '2026-09-15',
      '2026-09-22',
      '2026-09-29',
    ])
    expect(sessions.map((s) => s.weekNumber)).toEqual([1, 2, 3, 4, 5])
  })

  it('skips holidays without consuming a week number', () => {
    const holidays = [{ startsOn: d('2026-09-07'), endsOn: d('2026-09-13') }]
    const sessions = computeSessions(d('2026-09-01'), d('2026-09-22'), 1, holidays)
    expect(sessions.map((s) => s.date.toISOString().slice(0, 10))).toEqual([
      '2026-09-01',
      '2026-09-15',
      '2026-09-22',
    ])
    expect(sessions.map((s) => s.weekNumber)).toEqual([1, 2, 3])
  })

  it('advances to the first matching weekday after the start', () => {
    // Start Wed 2026-09-02, want Friday (dayOfWeek 4) -> first is 2026-09-04.
    const sessions = computeSessions(d('2026-09-02'), d('2026-09-18'), 4)
    expect(sessions[0]!.date.toISOString().slice(0, 10)).toBe('2026-09-04')
  })
})

describe('isHoliday', () => {
  it('is inclusive of both ends', () => {
    const h = [{ startsOn: d('2026-12-21'), endsOn: d('2027-01-04') }]
    expect(isHoliday(d('2026-12-21'), h)).toBe(true)
    expect(isHoliday(d('2027-01-04'), h)).toBe(true)
    expect(isHoliday(d('2027-01-05'), h)).toBe(false)
  })
})

describe('zonedWallTimeToUtc', () => {
  it('handles BST (summer, UTC+1)', () => {
    // 9 Sep 2026 18:00 Europe/London = 17:00 UTC (BST).
    const utc = zonedWallTimeToUtc(2026, 9, 9, 18 * 60, 'Europe/London')
    expect(utc.toISOString()).toBe('2026-09-09T17:00:00.000Z')
  })

  it('handles GMT (winter, UTC+0)', () => {
    // 6 Jan 2027 18:00 Europe/London = 18:00 UTC (GMT).
    const utc = zonedWallTimeToUtc(2027, 1, 6, 18 * 60, 'Europe/London')
    expect(utc.toISOString()).toBe('2027-01-06T18:00:00.000Z')
  })
})

describe('dueSessions', () => {
  const sessions = computeSessions(d('2026-09-01'), d('2026-09-15'), 1) // Tuesdays
  const tz = 'Europe/London'
  const startMinute = 18 * 60

  it('returns a session when the send window has just opened', () => {
    const firstStart = sessionStartInstant(sessions[0]!, startMinute, tz)
    const sendAt = sendAtFor(firstStart, 24)
    // now == sendAt exactly
    const due = dueSessions(sessions, startMinute, tz, 24, sendAt)
    expect(due).toHaveLength(1)
    expect(due[0]!.session.weekNumber).toBe(1)
  })

  it('does not send before the window or after the session started', () => {
    const firstStart = sessionStartInstant(sessions[0]!, startMinute, tz)
    const sendAt = sendAtFor(firstStart, 24)
    const beforeWindow = new Date(sendAt.getTime() - 60 * 60 * 1000)
    expect(dueSessions(sessions, startMinute, tz, 24, beforeWindow)).toHaveLength(0)
    const afterStart = new Date(firstStart.getTime() + 60 * 1000)
    // The first session is past; the look-back is short, so nothing is due.
    expect(dueSessions(sessions, startMinute, tz, 24, afterStart)).toHaveLength(0)
  })
})

describe('zoomRotationDue', () => {
  const now = new Date('2026-10-01T00:00:00.000Z')
  it('is due when never set', () => {
    expect(zoomRotationDue(null, 4, now)).toBe(true)
  })
  it('is due after the rotation interval', () => {
    const old = new Date('2026-08-01T00:00:00.000Z') // ~8.7 weeks before
    expect(zoomRotationDue(old, 4, now)).toBe(true)
  })
  it('is not due within the interval', () => {
    const recent = new Date('2026-09-20T00:00:00.000Z') // ~1.6 weeks before
    expect(zoomRotationDue(recent, 4, now)).toBe(false)
  })
})
