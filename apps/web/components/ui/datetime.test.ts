import { describe, expect, it } from 'vitest'

import {
  buildCalendarWeeks,
  formatWall,
  humanWallLabel,
  monthLabel,
  parseWall,
  shiftMonth,
} from './datetime'

describe('parseWall / formatWall', () => {
  it('round-trips a wall-clock string', () => {
    const p = parseWall('2026-07-02T14:30')
    expect(p).toEqual({ year: 2026, month: 7, day: 2, hour: 14, minute: 30 })
    expect(formatWall(p!)).toBe('2026-07-02T14:30')
  })

  it('zero-pads single-digit parts', () => {
    expect(formatWall({ year: 2026, month: 3, day: 5, hour: 9, minute: 0 })).toBe(
      '2026-03-05T09:00',
    )
  })

  it('returns null for empty / malformed input', () => {
    expect(parseWall('')).toBeNull()
    expect(parseWall(null)).toBeNull()
    expect(parseWall('not-a-date')).toBeNull()
    expect(parseWall('2026-07-02')).toBeNull()
  })
})

describe('buildCalendarWeeks', () => {
  it('lays out July 2026 Monday-first (1 Jul is a Wednesday)', () => {
    const weeks = buildCalendarWeeks(2026, 7)
    // Every row is 7 cells.
    expect(weeks.every((w) => w.length === 7)).toBe(true)
    // 1 Jul 2026 is a Wednesday → two leading blanks (Mon, Tue).
    expect(weeks[0]!.slice(0, 3)).toEqual([null, null, 1])
    // All 31 days present exactly once.
    const days = weeks.flat().filter((d): d is number => d != null)
    expect(days).toHaveLength(31)
    expect(days[0]).toBe(1)
    expect(days[days.length - 1]).toBe(31)
  })

  it('handles a February leap year', () => {
    const days = buildCalendarWeeks(2028, 2)
      .flat()
      .filter((d): d is number => d != null)
    expect(days).toHaveLength(29)
  })
})

describe('shiftMonth', () => {
  it('rolls forward across the year boundary', () => {
    expect(shiftMonth(2026, 12, 1)).toEqual({ year: 2027, month: 1 })
  })
  it('rolls backward across the year boundary', () => {
    expect(shiftMonth(2026, 1, -1)).toEqual({ year: 2025, month: 12 })
  })
  it('is a no-op for delta 0', () => {
    expect(shiftMonth(2026, 6, 0)).toEqual({ year: 2026, month: 6 })
  })
})

describe('monthLabel / humanWallLabel', () => {
  it('names the month and year', () => {
    expect(monthLabel(2026, 7)).toBe('July 2026')
  })

  it('renders a human wall-clock label without a timezone shift', () => {
    // 2 Jul 2026 is a Thursday — the numbers shown are exactly the parts stored.
    expect(humanWallLabel('2026-07-02T14:30')).toBe('Thu, 2 Jul 2026 · 14:30')
  })

  it('is empty for no value', () => {
    expect(humanWallLabel('')).toBe('')
    expect(humanWallLabel(null)).toBe('')
  })
})
