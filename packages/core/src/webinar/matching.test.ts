import { describe, expect, it } from 'vitest'

import { AUTO_ENROLL_CONFIDENCE, detectWebinarClasses, matchWebinarClass } from './matching'

describe('detectWebinarClasses', () => {
  it('matches a clear subject + level with high confidence', () => {
    const out = matchWebinarClass('A-Level Biology Weekly Class')
    expect(out).not.toBeNull()
    expect(out!.subject).toBe('biology')
    expect(out!.level).toBe('a_level')
    expect(out!.confidence).toBeGreaterThanOrEqual(AUTO_ENROLL_CONFIDENCE)
  })

  it('recognises GCSE', () => {
    const out = matchWebinarClass('GCSE Chemistry weekly subscription')
    expect(out!.subject).toBe('chemistry')
    expect(out!.level).toBe('gcse')
  })

  it('detects multiple subjects in one description', () => {
    const out = detectWebinarClasses('Biology and Physics GCSE bundle')
    const subjects = out.map((c) => c.subject).sort()
    expect(subjects).toEqual(['biology', 'physics'])
    expect(out.every((c) => c.level === 'gcse')).toBe(true)
  })

  it('defaults level to a_level but lowers confidence when level is absent', () => {
    const out = matchWebinarClass('Maths weekly class')
    expect(out!.subject).toBe('maths')
    expect(out!.level).toBe('a_level')
    expect(out!.confidence).toBeLessThan(AUTO_ENROLL_CONFIDENCE)
  })

  it('reads across multiple text fields (product + customer name)', () => {
    const out = matchWebinarClass('Weekly tuition', 'Physics A2', null)
    expect(out!.subject).toBe('physics')
    expect(out!.level).toBe('a_level')
  })

  it('returns no match for unrelated text', () => {
    expect(matchWebinarClass('One-off UCAT crash course')).toBeNull()
    expect(detectWebinarClasses('', null, undefined)).toEqual([])
  })

  it('does not false-match substrings', () => {
    // "biographies" should not match "bio" (word boundary).
    expect(matchWebinarClass('biographies book club')).toBeNull()
  })
})
