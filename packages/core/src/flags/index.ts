// Typed feature flag wrapper. Reads from env + the FeatureFlag table.
// See CLAUDE.md Section 31.

export type FlagKey =
  | 'gocardless.late_failure_reversal_enabled'
  | 'ai.draft_replies_enabled'
  | 'ui.density_compact_default'

export interface FlagContext {
  userId?: string
  familyId?: string
}

export interface FlagReader {
  isEnabled(key: FlagKey, ctx?: FlagContext): Promise<boolean>
}

export function createNoopFlagReader(): FlagReader {
  return {
    async isEnabled(): Promise<boolean> {
      return false
    },
  }
}
