import { describe, expect, it } from 'vitest'

import { buildSchedulePdf } from './pdf'

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    weekNumber: i + 1,
    dateLabel: `Sat ${(i % 28) + 1} Sep 2026`,
    topic: `Topic for week ${i + 1} with some reasonably long descriptive text to wrap`,
  }))

describe('buildSchedulePdf', () => {
  it('produces a valid single-page PDF for a short schedule', () => {
    const pdf = buildSchedulePdf({
      className: 'A-Level Biology',
      timeLabel: '18:00 BST',
      zoomLink: 'https://zoom.us/j/123',
      cohortName: '2026/2027',
      rows: rows(6),
    })
    const s = pdf.toString('latin1')
    expect(s.startsWith('%PDF-1.4')).toBe(true)
    expect(s.includes('%%EOF')).toBe(true)
    expect(s).toContain('A-Level Biology')
    expect(/\/Count 1\b/.test(s)).toBe(true)
  })

  it('paginates a full term across multiple pages', () => {
    const pdf = buildSchedulePdf({
      className: 'A-Level Biology',
      timeLabel: '18:00',
      zoomLink: null,
      cohortName: '2026/2027',
      rows: rows(42),
    })
    const count = Number(/\/Count (\d+)/.exec(pdf.toString('latin1'))?.[1])
    expect(count).toBeGreaterThan(1)
  })

  it('handles an empty schedule without throwing', () => {
    const pdf = buildSchedulePdf({
      className: 'New Group',
      timeLabel: '',
      zoomLink: null,
      cohortName: '2026/2027',
      rows: [],
    })
    expect(pdf.toString('latin1').startsWith('%PDF-1.4')).toBe(true)
  })
})
