import { describe, expect, it } from 'vitest'

import { extractNameCandidates } from './extract'

describe('extractNameCandidates', () => {
  it('extracts a first+last name from prose (the core name-only mention)', () => {
    expect(extractNameCandidates('Spoke to Aanya Sharma about the mocks')).toEqual([
      'Aanya Sharma',
    ])
  })

  it('the sentence opener alone is never a candidate', () => {
    // "Spoke", "Called" are sentence-start capitalised — not names.
    expect(extractNameCandidates('Spoke to her about rescheduling')).toEqual([])
    expect(extractNameCandidates('Called back, no answer')).toEqual([])
  })

  it('a leading verb absorbed into a sentence-start run still yields the name', () => {
    // "Called"/"Met"/"Rang" are capitalised at sentence start and get absorbed
    // into the proper-noun run; we additionally emit the run minus its first
    // token as a rescue candidate (matcher is unambiguous-only, so it's safe).
    expect(extractNameCandidates('Called Priya Sharma about the mocks')).toContain(
      'Priya Sharma',
    )
    expect(extractNameCandidates('Met John Smith earlier today')).toContain('John Smith')
    // A genuine sentence-start name is unaffected — the full run is still first.
    expect(extractNameCandidates('Priya Sharma called about the deposit')[0]).toBe(
      'Priya Sharma',
    )
  })

  it('a whole-message bare name IS a candidate (terse thread header)', () => {
    expect(extractNameCandidates('Sampada')).toEqual(['Sampada'])
    expect(extractNameCandidates('Sampada Neupane')).toEqual(['Sampada Neupane'])
  })

  it('mid-sentence single names count; stop words and acronyms never do', () => {
    expect(extractNameCandidates('call with Aanya went well')).toEqual(['Aanya'])
    expect(extractNameCandidates('meeting on Monday about UCAT')).toEqual([])
    expect(extractNameCandidates('the GCSE cohort CRM update')).toEqual([])
  })

  it('handles apostrophes and hyphens (O’Brien, Anne-Marie)', () => {
    expect(extractNameCandidates('spoke with Anne-Marie O’Brien today')).toEqual([
      'Anne-Marie O’Brien',
    ])
  })

  it('multi-word runs beat singles; candidates are deduped and capped', () => {
    const out = extractNameCandidates(
      'Handover: Aanya Sharma then Leisha Burgess then Aanya Sharma again with Bilal',
    )
    expect(out[0]).toBe('Aanya Sharma')
    expect(out).toContain('Leisha Burgess')
    expect(out.filter((c) => c === 'Aanya Sharma')).toHaveLength(1)
    expect(out.length).toBeLessThanOrEqual(5)
  })

  it('ignores Slack markup (mentions, links, emoji labels)', () => {
    expect(
      extractNameCandidates('<@U123> please chase <https://x.com|the invoice> for Aanya Sharma'),
    ).toEqual(['Aanya Sharma'])
  })

  it('runs of 4+ capitalised words (titles/headlines) are not names', () => {
    expect(extractNameCandidates('Weekly Ops Review Meeting Notes')).toEqual([])
  })
})
