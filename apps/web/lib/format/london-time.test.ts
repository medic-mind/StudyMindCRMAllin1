// Europe/London wall-clock ⇄ UTC round-trips, including the GMT/BST split.
// The conversion has no library behind it (CLAUDE.md "no new deps") — it
// leans on Intl — so the DST edges are exactly where bugs hide.

import { describe, expect, it } from 'vitest'

import { formatLondon, londonWallToUtc, utcToLondonWall } from './london-time'

describe('londonWallToUtc', () => {
  it('treats a winter (GMT) wall-clock as UTC+0', () => {
    // 15 Jan 2026 14:30 London == 14:30 UTC (GMT, no offset).
    const utc = londonWallToUtc('2026-01-15T14:30')
    expect(utc?.toISOString()).toBe('2026-01-15T14:30:00.000Z')
  })

  it('treats a summer (BST) wall-clock as UTC+1', () => {
    // 15 Jul 2026 14:30 London == 13:30 UTC (BST, +1).
    const utc = londonWallToUtc('2026-07-15T14:30')
    expect(utc?.toISOString()).toBe('2026-07-15T13:30:00.000Z')
  })

  it('returns null for empty or malformed input', () => {
    expect(londonWallToUtc('')).toBeNull()
    expect(londonWallToUtc('not-a-date')).toBeNull()
  })
})

describe('utcToLondonWall', () => {
  it('renders a BST instant back to London wall-clock', () => {
    expect(utcToLondonWall('2026-07-15T13:30:00.000Z')).toBe('2026-07-15T14:30')
  })

  it('renders a GMT instant back to London wall-clock', () => {
    expect(utcToLondonWall('2026-01-15T14:30:00.000Z')).toBe('2026-01-15T14:30')
  })

  it('is empty for null', () => {
    expect(utcToLondonWall(null)).toBe('')
  })
})

describe('round-trip', () => {
  it('wall → utc → wall is stable across the BST boundary', () => {
    for (const wall of [
      '2026-01-15T09:00',
      '2026-03-29T13:00', // day the clocks go forward
      '2026-07-15T14:30',
      '2026-10-25T12:00', // day the clocks go back
      '2026-12-31T23:45',
    ]) {
      const utc = londonWallToUtc(wall)
      expect(utc).not.toBeNull()
      expect(utcToLondonWall(utc)).toBe(wall)
    }
  })
})

describe('formatLondon', () => {
  it('formats a BST instant in UK local time', () => {
    // 13:30 UTC in July is 14:30 in London.
    const text = formatLondon('2026-07-15T13:30:00.000Z', {
      hour: '2-digit',
      minute: '2-digit',
    })
    expect(text).toBe('14:30')
  })
})
