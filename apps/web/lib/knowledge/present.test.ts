import { describe, expect, it } from 'vitest'

import {
  anchorId,
  asGlossaryRecord,
  asRecordGrid,
  asStatRecord,
  cardParts,
  classifyArray,
  extractSummary,
  isStepKey,
  looksLikeStat,
  partitionEntries,
  pickTitleKey,
  sectionItemCount,
  tocFor,
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

describe('isStepKey', () => {
  it('recognises sequential keys in any casing', () => {
    for (const key of ['guidance', 'steps', 'howItWorks', 'process', 'checklist', 'stepLadder']) {
      expect(isStepKey(key), key).toBe(true)
    }
  })

  it('rejects non-sequential keys and undefined', () => {
    expect(isStepKey('includes')).toBe(false)
    expect(isStepKey(undefined)).toBe(false)
  })
})

describe('anchorId + tocFor', () => {
  it('builds stable anchors from keys', () => {
    expect(anchorId('moneyBackGuarantee')).toBe('k-moneybackguarantee')
    expect(anchorId('ucat-1to1')).toBe('k-ucat-1to1')
  })

  it('lists complex keys of an object section, skipping the summary', () => {
    const toc = tocFor({
      summary: 'Intro',
      brand: 'medicmind',
      tiers: [],
      moneyBackGuarantee: { amount: '£500' },
    })
    expect(toc).toEqual([
      { id: 'k-tiers', label: 'Tiers' },
      { id: 'k-moneybackguarantee', label: 'Money back guarantee' },
    ])
  })

  it('returns nothing for arrays and scalars', () => {
    expect(tocFor([{ term: 'X', definition: 'y' }])).toEqual([])
    expect(tocFor('text')).toEqual([])
  })
})

describe('asRecordGrid', () => {
  it('detects a catalogue (5+ object entries)', () => {
    const entries = Object.entries({
      a: { name: 'A' },
      b: { name: 'B' },
      c: { name: 'C' },
      d: { name: 'D' },
      e: { name: 'E' },
    })
    expect(asRecordGrid(entries)?.length).toBe(5)
  })

  it('rejects small or mixed entry sets', () => {
    expect(asRecordGrid(Object.entries({ a: { x: 1 }, b: { x: 2 } }))).toBeNull()
    expect(
      asRecordGrid(
        Object.entries({ a: { x: 1 }, b: { x: 2 }, c: { x: 3 }, d: { x: 4 }, e: ['list'] }),
      ),
    ).toBeNull()
  })
})

describe('cardParts', () => {
  it('lifts stat and categorical scalars into badges', () => {
    const { title, badges, rest } = cardParts({
      title: 'Anxious teen reluctant to engage',
      tone: 'soft',
      hours: 60,
      guidance: ['a'],
    })
    expect(title).toBe('Anxious teen reluctant to engage')
    expect(badges).toEqual([
      ['Tone', 'soft'],
      ['Hours', '60'],
    ])
    expect(Object.keys(rest)).toEqual(['guidance'])
  })

  it('falls back to the provided title when no title key exists', () => {
    expect(cardParts({ hours: 60 }, 'UCAT 1to1').title).toBe('UCAT 1to1')
  })
})

describe('sectionItemCount', () => {
  it('counts array items and object keys', () => {
    expect(sectionItemCount([1, 2, 3])).toBe(3)
    expect(sectionItemCount({ a: 1, b: 2 })).toBe(2)
    expect(sectionItemCount('text')).toBeNull()
    expect(sectionItemCount(undefined)).toBeNull()
  })
})
