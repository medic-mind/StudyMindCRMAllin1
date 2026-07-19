import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DD_ISSUE_CUTOFF,
  ddIssueMeetsCutoff,
  resolveDdIssueCutoff,
} from './dd-issue-cutoff'

describe('resolveDdIssueCutoff', () => {
  it('defaults to go-live when unset', () => {
    expect(resolveDdIssueCutoff(undefined).getTime()).toBe(DEFAULT_DD_ISSUE_CUTOFF.getTime())
    expect(resolveDdIssueCutoff(null).getTime()).toBe(DEFAULT_DD_ISSUE_CUTOFF.getTime())
    expect(resolveDdIssueCutoff('').getTime()).toBe(DEFAULT_DD_ISSUE_CUTOFF.getTime())
    expect(resolveDdIssueCutoff('   ').getTime()).toBe(DEFAULT_DD_ISSUE_CUTOFF.getTime())
  })

  it('parses a YYYY-MM-DD or full ISO override', () => {
    expect(resolveDdIssueCutoff('2025-01-01').toISOString()).toBe('2025-01-01T00:00:00.000Z')
    expect(resolveDdIssueCutoff('2025-03-04T09:30:00.000Z').toISOString()).toBe(
      '2025-03-04T09:30:00.000Z',
    )
  })

  it('falls back to the default on an unparseable value', () => {
    expect(resolveDdIssueCutoff('not-a-date').getTime()).toBe(DEFAULT_DD_ISSUE_CUTOFF.getTime())
  })
})

describe('ddIssueMeetsCutoff', () => {
  const cutoff = new Date('2026-07-01T00:00:00.000Z')

  it('surfaces issues on or after the cutoff', () => {
    expect(ddIssueMeetsCutoff(new Date('2026-07-01T00:00:00.000Z'), cutoff)).toBe(true)
    expect(ddIssueMeetsCutoff(new Date('2026-08-15T00:00:00.000Z'), cutoff)).toBe(true)
  })

  it('hides issues before the cutoff (historic pre-go-live)', () => {
    expect(ddIssueMeetsCutoff(new Date('2020-03-01T00:00:00.000Z'), cutoff)).toBe(false)
    expect(ddIssueMeetsCutoff(new Date('2026-06-30T23:59:59.000Z'), cutoff)).toBe(false)
  })

  it('shows an undatable issue rather than hiding it (errs toward visibility)', () => {
    expect(ddIssueMeetsCutoff(null, cutoff)).toBe(true)
    expect(ddIssueMeetsCutoff(undefined, cutoff)).toBe(true)
  })
})
