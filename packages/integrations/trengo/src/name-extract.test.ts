// Tests for the rule-based name extractor — step 2 of the name-resolution
// waterfall (CLAUDE.md §11). Conservative: a miss is fine (AI/display
// fallback covers it), a false positive is not.

import { describe, expect, it } from 'vitest'

import {
  extractNameFromMessage,
  extractNameFromMessages,
  validateNameCandidate,
} from './name-extract'

describe('validateNameCandidate', () => {
  it('accepts 1–4 name-shaped tokens', () => {
    expect(validateNameCandidate('Sarah')).toBe('Sarah')
    expect(validateNameCandidate('Sarah Jane Smith')).toBe('Sarah Jane Smith')
    expect(validateNameCandidate("Aoife O'Brien")).toBe("Aoife O'Brien")
    expect(validateNameCandidate('Anne-Marie Kelly')).toBe('Anne-Marie Kelly')
  })

  it('rejects sentence openers, lowercase words, digits, and long strings', () => {
    expect(validateNameCandidate('interested in tuition')).toBeNull()
    expect(validateNameCandidate('looking')).toBeNull()
    expect(validateNameCandidate('sarah')).toBeNull()
    expect(validateNameCandidate('Flat 4B')).toBeNull()
    expect(validateNameCandidate('A very long string of words here')).toBeNull()
  })
})

describe('extractNameFromMessage', () => {
  it('reads "my name is …"', () => {
    expect(extractNameFromMessage('Hi, my name is Sarah Jones and I need help')).toBe(
      'Sarah Jones',
    )
    expect(extractNameFromMessage("my name's Tom")).toBe('Tom')
  })

  it('reads "this is …" only when name-shaped', () => {
    expect(extractNameFromMessage('Hello this is Priya Patel')).toBe('Priya Patel')
    expect(extractNameFromMessage('this is regarding my son')).toBeNull()
  })

  it('reads "I\'m …" but not "I\'m interested…"', () => {
    expect(extractNameFromMessage("Hi I'm David Okafor, calling about GCSE maths")).toBe(
      'David Okafor',
    )
    expect(extractNameFromMessage("I'm interested in the summer camp")).toBeNull()
    expect(extractNameFromMessage("I'm looking for a tutor")).toBeNull()
  })

  it('reads sign-offs on the same line and the next line', () => {
    expect(extractNameFromMessage('Sounds good.\n\nThanks,\nRebecca')).toBe('Rebecca')
    expect(extractNameFromMessage('See you then. Kind regards, Amir Khan')).toBe(
      'Amir Khan',
    )
    expect(extractNameFromMessage('Best wishes\nFatima Ali\n07700900123')).toBe(
      'Fatima Ali',
    )
  })

  it('does not treat a plain thanks as a name', () => {
    expect(extractNameFromMessage('Thanks!')).toBeNull()
    expect(extractNameFromMessage('Thanks so much')).toBeNull()
    expect(extractNameFromMessage('ok thanks, see you tomorrow')).toBeNull()
  })

  it('reads "Name: …" forms', () => {
    expect(extractNameFromMessage('Name: Lucy Wright\nSubject: Chemistry')).toBe(
      'Lucy Wright',
    )
  })
})

describe('extractNameFromMessages', () => {
  it('returns the first hit, oldest first', () => {
    expect(
      extractNameFromMessages([
        'Hi, do you do A-Level biology?',
        "I'm Hannah Lee by the way",
        'My name is Someone Else',
      ]),
    ).toBe('Hannah Lee')
  })

  it('returns null when nothing matches', () => {
    expect(extractNameFromMessages(['hi', 'can you call me back?', ''])).toBeNull()
  })
})
