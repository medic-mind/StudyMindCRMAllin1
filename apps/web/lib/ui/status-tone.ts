// Shared status → Badge tone/label source of truth.
//
// The CRM had grown ~30 per-file status-colour maps, several byte-duplicated
// with clashing shades (e.g. call outcome rendered green-100 in one file and
// emerald-50+ring in another; the hours-risk map copied verbatim into two
// files). That is the "two badge languages" problem. This module defines each
// domain status ONCE and returns a shared `BadgeTone`, so every surface renders
// through `<Badge tone={…}>` and status colour can never drift between pages.
// CLAUDE.md §4 (semantic colours; no new status colours without a token).

import type { BadgeTone } from '@/components/ui/badge'

/* -------------------------------------------------------------------------- */
/* Hours-risk level (derived, §6.4) — Contacts table + At-risk dashboard.      */
/* -------------------------------------------------------------------------- */

export function riskTone(level: string): BadgeTone {
  switch (level) {
    case 'high':
      return 'danger'
    case 'medium':
      return 'warn'
    case 'low':
      return 'neutral'
    default:
      return 'neutral'
  }
}

export function riskLabel(level: string): string {
  switch (level) {
    case 'high':
      return 'High risk'
    case 'medium':
      return 'At risk'
    case 'low':
      return 'Watch'
    default:
      return ''
  }
}

/* -------------------------------------------------------------------------- */
/* Call outcome — contact Calls section + the Aircall call-history table.      */
/* -------------------------------------------------------------------------- */

export function callOutcomeTone(outcome: string): BadgeTone {
  switch (outcome) {
    case 'answered':
      return 'success'
    case 'voicemail':
      return 'warn'
    case 'missed':
    case 'no_answer':
      return 'danger'
    default:
      return 'neutral'
  }
}
