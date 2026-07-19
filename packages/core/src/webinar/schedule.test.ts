import { describe, expect, it } from 'vitest'

import {
  computeSessions,
  currentWeekInfo,
  isHoliday,
  localCalendar,
  reminderDayNow,
  sessionForLocalWeek,
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

describe('reminder send-day model', () => {
  const tz = 'Europe/London'
  // Sessions on Saturdays (dayOfWeek 5) in Sept 2026.
  const sessions = computeSessions(d('2026-09-01'), d('2026-09-30'), 5)

  it('localCalendar resolves weekday 0=Mon and the local hour', () => {
    // 2026-09-07 is a Monday; 10:00 UTC = 11:00 BST.
    const cal = localCalendar(new Date('2026-09-07T10:00:00Z'), tz)
    expect(cal.weekday).toBe(0)
    expect(cal.hour).toBe(11)
  })

  it('reminderDayNow fires only on configured days at/after the send hour', () => {
    // Monday 2026-09-07 09:00 BST = 08:00 UTC.
    const monAt9 = new Date('2026-09-07T08:00:00Z')
    expect(reminderDayNow(monAt9, tz, [0, 1], 9)).toBe(0)
    // Monday 08:00 BST (before the 9am send hour) → not yet.
    const monAt8 = new Date('2026-09-07T07:00:00Z')
    expect(reminderDayNow(monAt8, tz, [0, 1], 9)).toBeNull()
    // Wednesday is not a configured send day.
    const wed = new Date('2026-09-09T10:00:00Z')
    expect(reminderDayNow(wed, tz, [0, 1], 9)).toBeNull()
  })

  it('sessionForLocalWeek returns that week’s Saturday session', () => {
    // The Monday of the week containing Sat 2026-09-12.
    const mon = new Date('2026-09-07T08:00:00Z')
    const s = sessionForLocalWeek(sessions, mon, tz)
    expect(s?.date.toISOString().slice(0, 10)).toBe('2026-09-12')
  })
})

describe('currentWeekInfo', () => {
  const tz = 'Europe/London'
  // Saturdays in Sept 2026: 05(W1), 12(W2), 19(W3), 26(W4).
  const sessions = computeSessions(d('2026-09-01'), d('2026-09-30'), 5)

  it('knows the current teaching week', () => {
    // Monday 2026-09-07 is in the week of Sat 2026-09-12 = week 2.
    const info = currentWeekInfo(sessions, new Date('2026-09-07T09:00:00Z'), tz)
    expect(info.state).toBe('in_week')
    expect(info.weekNumber).toBe(2)
    expect(info.totalWeeks).toBe(4)
  })

  it('reports not_started before the term and points at week 1', () => {
    const info = currentWeekInfo(sessions, new Date('2026-08-20T09:00:00Z'), tz)
    expect(info.state).toBe('not_started')
    expect(info.date?.toISOString().slice(0, 10)).toBe('2026-09-05')
  })

  it('reports ended after the term', () => {
    const info = currentWeekInfo(sessions, new Date('2026-10-20T09:00:00Z'), tz)
    expect(info.state).toBe('ended')
  })

  it('reports between (holiday week) and points at the next session', () => {
    const holidaySessions = computeSessions(d('2026-09-01'), d('2026-09-30'), 5, [
      { startsOn: d('2026-09-07'), endsOn: d('2026-09-13') }, // knocks out Sat 09-12
    ])
    const info = currentWeekInfo(holidaySessions, new Date('2026-09-07T09:00:00Z'), tz)
    expect(info.state).toBe('between')
    expect(info.date?.toISOString().slice(0, 10)).toBe('2026-09-19')
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
