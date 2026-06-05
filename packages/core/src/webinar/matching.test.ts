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

  it('detects English Language but not English Literature', () => {
    const ok = matchWebinarClass('GCSE English Language weekly class')
    expect(ok!.subject).toBe('english_language')
    expect(ok!.level).toBe('gcse')
    expect(matchWebinarClass('A-Level English Literature')).toBeNull()
  })

  it('maps year groups to levels (Y12/13 → A-level, Y10/11 → GCSE)', () => {
    expect(matchWebinarClass('Biology Year 13 group')!.level).toBe('a_level')
    expect(matchWebinarClass('Maths Y10 group')!.level).toBe('gcse')
  })

  it('reads level from metadata-style text (a_level with underscore)', () => {
    const out = matchWebinarClass('subject biology', 'level a_level')
    expect(out!.subject).toBe('biology')
    expect(out!.level).toBe('a_level')
  })

  it('handles a multi-subject bundle in one product', () => {
    const out = detectWebinarClasses('GCSE Science Bundle: Biology, Chemistry, Physics')
    expect(out.map((c) => c.subject).sort()).toEqual(['biology', 'chemistry', 'physics'])
    expect(out.every((c) => c.level === 'gcse')).toBe(true)
  })

  it('ignores billing words and still matches subject+level', () => {
    const out = matchWebinarClass('A-Level Chemistry — yearly subscription')
    expect(out!.subject).toBe('chemistry')
    expect(out!.level).toBe('a_level')
    expect(out!.confidence).toBeGreaterThanOrEqual(0.8)
  })
})
