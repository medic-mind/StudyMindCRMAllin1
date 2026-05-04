// Feature flag registry. See CLAUDE.md Section 31.
//
// Flags are either:
//   - 'release':     decouples deploy from launch, default off, removed within
//                    30 days of full launch.
//   - 'operational': long-lived kill switches for risky paths.
//
// Adding a flag is a code change. UI cannot mutate flags directly; runtime
// toggles go through `setFlag` in ./admin which writes an audit entry.

export interface FlagMetadata {
  description: string
  kind: 'release' | 'operational'
  default: boolean
  owner: string
}

export const FLAGS = {
  'gocardless.late_failure_reversal_enabled': {
    description:
      'Reverse confirmed Bacs payments on late_failure_settled events and reopen allocations.',
    kind: 'operational',
    default: true,
    owner: 'finance',
  },
  'safeguarding.dsl_break_glass_alert': {
    description: 'Page on KMS break-glass usage by the on-call DSL role.',
    kind: 'operational',
    default: true,
    owner: 'dsl',
  },
  'ai.tender_drafting_enabled': {
    description: 'Enable AI-assisted LA tender drafting in the tenders surface.',
    kind: 'release',
    default: false,
    owner: 'tech-lead',
  },
  'ai.draft_replies_enabled': {
    description: 'Show AI-drafted reply suggestions in the inbox composer.',
    kind: 'release',
    default: false,
    owner: 'tech-lead',
  },
  'finance.dunning_paused': {
    description: 'Kill switch to pause all dunning notifications and escalations.',
    kind: 'operational',
    default: false,
    owner: 'finance',
  },
  'ui.density_compact_default': {
    description: 'Default new users to compact density in CRM lists.',
    kind: 'release',
    default: false,
    owner: 'design',
  },
  'booking.push_webhook_enabled': {
    description:
      'Accept push webhooks from booking.studymind.co.uk in addition to scheduled pull.',
    kind: 'release',
    default: false,
    owner: 'tech-lead',
  },
} as const satisfies Record<string, FlagMetadata>

export type FlagName = keyof typeof FLAGS

export function isFlagName(name: string): name is FlagName {
  return Object.prototype.hasOwnProperty.call(FLAGS, name)
}
