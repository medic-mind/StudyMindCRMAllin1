import { describe, expect, it } from 'vitest'

import { cardMatchesQuery, filterCardsByQuery, type SearchableCard } from './card-search'

const base: SearchableCard = {
  contactName: 'Shamin Anari',
  contactEmail: 'anarishamin@gmail.com',
  contactPhone: '+447852544479',
  company: { name: 'Medic Mind' },
  subject: { name: 'UCAT' },
  enquiryTypes: ['Tutoring'],
  labels: [{ name: 'Priority' }],
  assigneeName: 'Jo Lee',
  assigneeEmail: 'jo@example.test',
  description: 'Wants 1-1 tutoring in the mornings',
}

describe('cardMatchesQuery', () => {
  it('matches everything for an empty query', () => {
    expect(cardMatchesQuery(base, '')).toBe(true)
    expect(cardMatchesQuery(base, '   ')).toBe(true)
  })

  it('matches by name, case-insensitively', () => {
    expect(cardMatchesQuery(base, 'shamin')).toBe(true)
    expect(cardMatchesQuery(base, 'ANARI')).toBe(true)
  })

  it('matches by email, subject, company, label, enquiry type and assignee', () => {
    expect(cardMatchesQuery(base, 'gmail')).toBe(true)
    expect(cardMatchesQuery(base, 'ucat')).toBe(true)
    expect(cardMatchesQuery(base, 'medic')).toBe(true)
    expect(cardMatchesQuery(base, 'priority')).toBe(true)
    expect(cardMatchesQuery(base, 'tutoring')).toBe(true)
    expect(cardMatchesQuery(base, 'jo lee')).toBe(true)
  })

  it('is AND across whitespace-separated terms', () => {
    expect(cardMatchesQuery(base, 'shamin ucat')).toBe(true)
    expect(cardMatchesQuery(base, 'shamin gamsat')).toBe(false)
  })

  it('matches a phone number in any format', () => {
    expect(cardMatchesQuery(base, '07852 544479')).toBe(true)
    expect(cardMatchesQuery(base, '+44 7852 544479')).toBe(true)
    expect(cardMatchesQuery(base, '447852544479')).toBe(true)
    // A short digit run is text-matched against the raw stored number.
    expect(cardMatchesQuery(base, '7852')).toBe(true)
  })

  it('a phone-shaped query that does not match the number is not a text match', () => {
    expect(cardMatchesQuery(base, '999999')).toBe(false)
  })

  it('returns false when nothing matches', () => {
    expect(cardMatchesQuery(base, 'chemistry')).toBe(false)
  })

  it('handles a card with only a name (no optional fields)', () => {
    const minimal: SearchableCard = { contactName: 'Alex Doe', labels: [] }
    expect(cardMatchesQuery(minimal, 'alex')).toBe(true)
    expect(cardMatchesQuery(minimal, 'doe')).toBe(true)
    expect(cardMatchesQuery(minimal, 'ucat')).toBe(false)
    expect(cardMatchesQuery(minimal, '07700900123')).toBe(false)
  })
})

describe('filterCardsByQuery', () => {
  const cards: SearchableCard[] = [
    base,
    { contactName: 'Priya Shah', subject: { name: 'GAMSAT' }, labels: [] },
    { contactName: 'Tom Reed', subject: { name: 'UCAT' }, labels: [] },
  ]

  it('returns every card for an empty query (a copy, not the same array)', () => {
    const out = filterCardsByQuery(cards, '')
    expect(out).toHaveLength(3)
    expect(out).not.toBe(cards)
  })

  it('narrows to matching cards, preserving order', () => {
    const ucat = filterCardsByQuery(cards, 'ucat')
    expect(ucat.map((c) => c.contactName)).toEqual(['Shamin Anari', 'Tom Reed'])
  })

  it('returns an empty array when nothing matches', () => {
    expect(filterCardsByQuery(cards, 'physics')).toEqual([])
  })
})
