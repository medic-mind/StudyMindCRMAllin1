import { describe, expect, it } from 'vitest'

import {
  asGlossaryRecord,
  asStatRecord,
  classifyArray,
  extractSummary,
  looksLikeStat,
  partitionEntries,
  pickTitleKey,
} from './present'

describe('looksLikeStat', () => {
  it('recognises money, hours, percentages, counts and ranges', () => {
    for (const v of ['£500', '£12.50–15 per hour', '100', '105', '2 hours', '50%', '1× UCAT', '£40/hr at 5h → £30/hr at 100h']) {
      expect(looksLikeStat(v), v).toBe(true)
    }
  })

  it('rejects prose and over-long strings', () => {
    expect(looksLikeStat('Lead with flexibility')).toBe(false)
    expect(looksLikeStat('£500 refund if the student does not receive any offer at all from medical school')).toBe(false)
    expect(looksLikeStat('')).toBe(false)
  })
})

describe('asStatRecord', () => {
  it('reads {label, value, notes}', () => {
    expect(
      asStatRecord({ label: 'Bronze', value: '£40/hr', notes: 'entry tier' }),
    ).toEqual({ label: 'Bronze', value: '£40/hr', note: 'entry tier' })
  })

  it('reads {label, value} with no note', () => {
    expect(asStatRecord({ label: 'X', value: '£1' })).toEqual({
      label: 'X',
      value: '£1',
      note: null,
    })
  })

  it('rejects records without a label+value pair or with extra keys', () => {
    expect(asStatRecord({ label: 'X' })).toBeNull()
    expect(asStatRecord({ a: 1, b: 2, c: 3, d: 4 })).toBeNull()
    expect(asStatRecord({ name: 'X', hours: 60, tutor: 'Std', extra: 'y' })).toBeNull()
  })
})

describe('asGlossaryRecord', () => {
  it('reads {term, definition} and {question, answer}', () => {
    expect(asGlossaryRecord({ term: 'UCAT', definition: 'A test' })).toEqual({
      term: 'UCAT',
      definition: 'A test',
    })
    expect(asGlossaryRecord({ question: 'Why?', answer: 'Because' })).toEqual({
      term: 'Why?',
      definition: 'Because',
    })
  })

  it('rejects other shapes', () => {
    expect(asGlossaryRecord({ name: 'X', hours: 1 })).toBeNull()
  })
})

describe('classifyArray', () => {
  it('chips for short scalars, bullets for long ones', () => {
    expect(classifyArray(['Biology', 'Chemistry', 'Physics'])).toBe('chips')
    expect(
      classifyArray([
        'A very long sentence that goes well beyond the chip length budget and should bullet instead of chipping',
      ]),
    ).toBe('bullets')
  })

  it('stats for label/value records', () => {
    expect(
      classifyArray([
        { label: 'A', value: '£1' },
        { label: 'B', value: '£2', notes: 'x' },
      ]),
    ).toBe('stats')
  })

  it('glossary for term/definition records', () => {
    expect(
      classifyArray([
        { term: 'UCAT', definition: 'x' },
        { term: 'GAMSAT', definition: 'y' },
      ]),
    ).toBe('glossary')
  })

  it('cards for titled records', () => {
    expect(
      classifyArray([
        { name: 'Bronze', hours: 60, includes: ['a', 'b'] },
        { name: 'Silver', hours: 80, includes: ['a'] },
      ]),
    ).toBe('cards')
  })

  it('table for flat untitled records', () => {
    expect(
      classifyArray([
        { mon: 'Biology', gcse: 'Maths' },
        { mon: 'Chemistry', gcse: 'Physics' },
      ]),
    ).toBe('table')
  })

  it('empty for an empty array', () => {
    expect(classifyArray([])).toBe('empty')
  })
})

describe('partitionEntries', () => {
  it('splits scalar and complex keys', () => {
    const { scalars, complex } = partitionEntries({
      name: 'Bronze',
      hours: 60,
      includes: ['a', 'b'],
      split: { ucat: 40 },
    })
    expect(scalars.map(([k]) => k)).toEqual(['name', 'hours'])
    expect(complex.map(([k]) => k)).toEqual(['includes', 'split'])
  })
})

describe('extractSummary', () => {
  it('lifts a summary string and returns the rest', () => {
    const { summary, rest } = extractSummary({ summary: 'Overview text', tiers: [] })
    expect(summary).toBe('Overview text')
    expect(Object.keys(rest)).toEqual(['tiers'])
  })

  it('returns null when there is no summary', () => {
    expect(extractSummary({ tiers: [] }).summary).toBeNull()
  })
})

describe('pickTitleKey', () => {
  it('prefers name/title/tier over other keys', () => {
    expect(pickTitleKey({ tier: 'Gold', hours: 100 })).toBe('tier')
    expect(pickTitleKey({ hours: 100 })).toBeNull()
  })
})
