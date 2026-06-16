import { describe, expect, it } from 'vitest'

import { candidateFromParsed } from './relink'

describe('candidateFromParsed', () => {
  it('reads the stored slack-summary extraction', () => {
    const c = candidateFromParsed({
      candidateContactIdentifier: { name: 'Aanya Patel', email: null, phone: '07700 900123' },
      summary: 'Wants to book UCAT tutoring',
      category: 'sales',
      sentiment: 'positive',
      suggestedNextAction: 'Send pricing',
      confidence: 0.6,
      promptVersion: '2026-06-11.1',
    })
    expect(c).toMatchObject({
      name: 'Aanya Patel',
      email: null,
      phone: '07700 900123',
      summary: 'Wants to book UCAT tutoring',
      category: 'sales',
      promptVersion: '2026-06-11.1',
    })
  })

  it('is defensive about missing / blank fields', () => {
    expect(candidateFromParsed({})).toEqual({
      name: null,
      email: null,
      phone: null,
      summary: null,
      category: null,
      sentiment: null,
      suggestedNextAction: null,
      promptVersion: null,
    })
    expect(candidateFromParsed(null).name).toBeNull()
    expect(candidateFromParsed({ candidateContactIdentifier: { name: '  ' } }).name).toBeNull()
  })
})
