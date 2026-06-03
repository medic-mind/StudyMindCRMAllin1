import { describe, expect, it } from 'vitest'

import {
  describePeakWindow,
  inSeason,
  instantMatchesWindow,
  isPeakInstant,
  type PeakInstant,
  type PeakWindowDef,
} from './peak-windows'

const base: PeakWindowDef = {
  id: 'w1',
  name: 'Exam season evenings',
  startMonth: 8,
  startDay: 15,
  endMonth: 9,
  endDay: 30,
  daysOfWeek: [0, 1, 2, 3, 4], // Mon–Fri
  startHour: 16,
  endHour: 20,
  year: null,
  color: 'amber-500',
}

function instant(p: Partial<PeakInstant>): PeakInstant {
  return { year: 2026, month: 9, day: 1, dow: 0, hour: 17, ...p }
}

describe('inSeason', () => {
  it('matches inside a normal (non-wrapping) season', () => {
    expect(inSeason(base, 9, 1)).toBe(true)
    expect(inSeason(base, 8, 15)).toBe(true)
    expect(inSeason(base, 9, 30)).toBe(true)
  })

  it('rejects dates outside the season', () => {
    expect(inSeason(base, 8, 14)).toBe(false)
    expect(inSeason(base, 10, 1)).toBe(false)
  })

  it('handles a season that wraps the year boundary', () => {
    const winter: PeakWindowDef = { ...base, startMonth: 11, startDay: 1, endMonth: 2, endDay: 28 }
    expect(inSeason(winter, 12, 25)).toBe(true)
    expect(inSeason(winter, 1, 10)).toBe(true)
    expect(inSeason(winter, 6, 1)).toBe(false)
  })
})

describe('instantMatchesWindow', () => {
  it('matches a weekday evening inside the season', () => {
    expect(instantMatchesWindow(base, instant({}))).toBe(true)
  })

  it('rejects the wrong day of week', () => {
    expect(instantMatchesWindow(base, instant({ dow: 5 }))).toBe(false) // Saturday
  })

  it('treats the end hour as exclusive', () => {
    expect(instantMatchesWindow(base, instant({ hour: 19 }))).toBe(true)
    expect(instantMatchesWindow(base, instant({ hour: 20 }))).toBe(false)
    expect(instantMatchesWindow(base, instant({ hour: 15 }))).toBe(false)
  })

  it('respects a year-pinned window', () => {
    const pinned: PeakWindowDef = { ...base, year: 2025 }
    expect(instantMatchesWindow(pinned, instant({ year: 2025 }))).toBe(true)
    expect(instantMatchesWindow(pinned, instant({ year: 2026 }))).toBe(false)
  })

  it('fails closed on an inverted hour band', () => {
    const bad: PeakWindowDef = { ...base, startHour: 20, endHour: 16 }
    expect(instantMatchesWindow(bad, instant({ hour: 18 }))).toBe(false)
  })
})

describe('isPeakInstant', () => {
  it('is peak when any window matches', () => {
    const other: PeakWindowDef = { ...base, id: 'w2', daysOfWeek: [5, 6], startHour: 9, endHour: 12 }
    expect(isPeakInstant([base, other], instant({ dow: 6, hour: 10 }))).toBe(true)
    expect(isPeakInstant([base, other], instant({ dow: 6, hour: 14 }))).toBe(false)
  })

  it('is never peak with no windows', () => {
    expect(isPeakInstant([], instant({}))).toBe(false)
  })
})

describe('describePeakWindow', () => {
  it('summarises weekdays and an hour band', () => {
    expect(describePeakWindow(base)).toEqual({
      season: 'Aug 15 – Sep 30',
      days: 'Weekdays',
      hours: '16:00 – 20:00',
      year: 'Every year',
    })
  })

  it('labels weekends, every-day, and a pinned year', () => {
    expect(describePeakWindow({ ...base, daysOfWeek: [5, 6] }).days).toBe('Weekends')
    expect(describePeakWindow({ ...base, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] }).days).toBe('Every day')
    expect(describePeakWindow({ ...base, year: 2027 }).year).toBe('2027')
  })

  it('lists an irregular day set', () => {
    expect(describePeakWindow({ ...base, daysOfWeek: [0, 2, 4] }).days).toBe('Mon, Wed, Fri')
  })
})
