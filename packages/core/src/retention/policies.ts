// Retention policy resolver. CLAUDE.md §21.
//
// Pure helper that decides, for a single row, when it should be soft-deleted
// and how long the grace window is before hard-delete. It reads from the
// per-row context (LA contract id, etc) and the system defaults below.
//
// Categories map directly to the rows we age out. They are stable strings
// because RetentionPolicy.scope is free-text (the override mechanism uses
// the same strings).

export type RetentionCategory =
  | 'callRecording'
  | 'callTranscript'
  | 'email'
  | 'generalNote'
  | 'marketingLead'

export interface RetentionDefaults {
  callRecordingDays: number
  callTranscriptDays: number
  emailDays: number
  generalNoteDays: number
  marketingLeadDays: number
}

/** CLAUDE.md §21 retention defaults. */
export const RETENTION_DEFAULTS: RetentionDefaults = {
  callRecordingDays: 90,
  callTranscriptDays: 365,
  emailDays: 7 * 365,
  generalNoteDays: 7 * 365,
  marketingLeadDays: 365,
}

/** Default grace window between soft-delete and hard-delete (CLAUDE.md §21). */
export const HARD_DELETE_GRACE_DAYS = 30

export interface ContractContext {
  /** Optional LA contract id this row is associated with. */
  laContractId?: string | null
  /** Optional resolved override (already looked up by the caller). */
  contractOverrideDays?: number | null
}

export interface EffectiveRetentionInput {
  category: RetentionCategory
  contract?: ContractContext
}

export interface EffectiveRetentionResult {
  /** Days from row creation at which the row is soft-deletable. */
  softDeleteAfterDays: number
  /** Days between soft-delete and hard-delete. */
  hardDeleteGraceDays: number
}

/**
 * Compute the effective retention for a row in a given category. Pure.
 *
 * Fail-closed: an unknown category throws a `BusinessError`-shaped Error so
 * callers cannot accidentally skip deletion on a typo.
 */
export function effectiveRetentionForRow(
  input: EffectiveRetentionInput,
): EffectiveRetentionResult {
  const override = input.contract?.contractOverrideDays
  if (override && override > 0) {
    return {
      softDeleteAfterDays: override,
      hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
    }
  }
  switch (input.category) {
    case 'callRecording':
      return {
        softDeleteAfterDays: RETENTION_DEFAULTS.callRecordingDays,
        hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
      }
    case 'callTranscript':
      return {
        softDeleteAfterDays: RETENTION_DEFAULTS.callTranscriptDays,
        hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
      }
    case 'email':
      return {
        softDeleteAfterDays: RETENTION_DEFAULTS.emailDays,
        hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
      }
    case 'generalNote':
      return {
        softDeleteAfterDays: RETENTION_DEFAULTS.generalNoteDays,
        hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
      }
    case 'marketingLead':
      return {
        softDeleteAfterDays: RETENTION_DEFAULTS.marketingLeadDays,
        hardDeleteGraceDays: HARD_DELETE_GRACE_DAYS,
      }
    default: {
      // Exhaustiveness: unknown category fails closed.
      const _exhaustive: never = input.category
      throw new Error(`Unknown retention category: ${String(_exhaustive)}`)
    }
  }
}

/**
 * Convenience: compute the cutoff `Date` at which rows in this category are
 * eligible for soft-delete given `now`.
 */
export function softDeleteCutoff(
  category: RetentionCategory,
  now: Date,
  contract?: ContractContext,
): Date {
  const { softDeleteAfterDays } = effectiveRetentionForRow({ category, contract })
  const cutoff = new Date(now.getTime())
  cutoff.setUTCDate(cutoff.getUTCDate() - softDeleteAfterDays)
  return cutoff
}

/** Compute the `pendingHardDeleteAt` value (= `now + grace`). */
export function pendingHardDeleteAt(
  category: RetentionCategory,
  now: Date,
  contract?: ContractContext,
): Date {
  const { hardDeleteGraceDays } = effectiveRetentionForRow({ category, contract })
  const at = new Date(now.getTime())
  at.setUTCDate(at.getUTCDate() + hardDeleteGraceDays)
  return at
}
