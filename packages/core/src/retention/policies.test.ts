// Tests for the retention policy resolver. Pure functions; no I/O.

import { describe, expect, it } from 'vitest'

import {
  effectiveRetentionForRow,
  HARD_DELETE_GRACE_DAYS,
  pendingHardDeleteAt,
  RETENTION_DEFAULTS,
  softDeleteCutoff,
} from './policies'

describe('effectiveRetentionForRow', () => {
  it('applies defaults per category', () => {
    expect(effectiveRetentionForRow({ category: 'callRecording' })).toEqual({
      softDeleteAfterDays: RETENTION_DEFAULTS.callRecordingDays,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    })
    expect(effectiveRetentionForRow({ category: 'callTranscript' })).toEqual({
      softDeleteAfterDays: RETENTION_DEFAULTS.callTranscriptDays,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    })
    expect(effectiveRetentionForRow({ category: 'email' })).toEqual({
      softDeleteAfterDays: RETENTION_DEFAULTS.emailDays,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    })
    expect(effectiveRetentionForRow({ category: 'generalNote' })).toEqual({
      softDeleteAfterDays: RETENTION_DEFAULTS.generalNoteDays,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    })
    expect(effectiveRetentionForRow({ category: 'marketingLead' })).toEqual({
      softDeleteAfterDays: RETENTION_DEFAULTS.marketingLeadDays,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    })
  })

  it('honours a per-contract override', () => {
    const r = effectiveRetentionForRow({
      category: 'email',
      contract: { laContractId: 'la-1', contractOverrideDays: 25 * 365 },
    })
    expect(r.softDeleteAfterDays).toBe(25 * 365)
    expect(r.hardDeleteGraceDays).toBe(HARD_DELETE_GRACE_DAYS)
  })

  it('ignores zero or negative overrides and falls back to defaults', () => {
    const r = effectiveRetentionForRow({
      category: 'email',
      contract: { contractOverrideDays: 0 },
    })
    expect(r.softDeleteAfterDays).toBe(RETENTION_DEFAULTS.emailDays)
  })

  it('fails closed on unknown category', () => {
    // We deliberately cast through unknown to assert the runtime guard.
    expect(() =>
      effectiveRetentionForRow({
        category: 'nope' as unknown as 'email',
      }),
    ).toThrow(/Unknown retention category/)
  })
})

describe('softDeleteCutoff', () => {
  it('returns now minus the policy days', () => {
    const now = new Date('2026-05-10T00:00:00Z')
    const cutoff = softDeleteCutoff('callRecording', now)
    // 90 days before
    expect(cutoff.toISOString()).toBe('2026-02-09T00:00:00.000Z')
  })
})

describe('pendingHardDeleteAt', () => {
  it('returns now plus the grace days', () => {
    const now = new Date('2026-05-10T00:00:00Z')
    const at = pendingHardDeleteAt('email', now)
    // +30 days grace
    expect(at.toISOString()).toBe('2026-06-09T00:00:00.000Z')
  })
})
