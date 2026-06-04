import { describe, expect, it } from 'vitest'

import { splitDisplayName } from './from-call'

describe('splitDisplayName', () => {
  it('splits first and last on the first space', () => {
    expect(splitDisplayName('Ada Lovelace')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
  })

  it('keeps multi-word surnames in lastName', () => {
    expect(splitDisplayName('Ada Van Der Berg')).toEqual({
      firstName: 'Ada',
      lastName: 'Van Der Berg',
    })
  })

  it('returns a null lastName for a single token', () => {
    expect(splitDisplayName('Ada')).toEqual({ firstName: 'Ada', lastName: null })
  })

  it('collapses extra whitespace', () => {
    expect(splitDisplayName('  Ada   Lovelace  ')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    })
  })
})
