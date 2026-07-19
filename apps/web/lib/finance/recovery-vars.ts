// Build the token values for a Direct Debit recovery message from a case's live
// figures (ADR 0045 amendment). One place so the automated engine and the
// manual send show the customer the SAME numbers — including the calculated
// CCJ court fee + statutory interest for the letter-before-claim steps.
//
// The CCJ figures are always computed and passed; only templates that reference
// {{court_fee}} / {{interest}} / {{total_with_costs}} (the stern / CCJ steps)
// actually show them, so the gentle reminders stay gentle. The policy figures
// (late fee, response window, finance phone) come from the customisable
// recovery settings (Settings → DD recovery), not hardcoded.

import {
  buildRecoveryVars,
  estimateCcjCosts,
  type CcjEstimate,
  type RecoveryTemplateVars,
} from '@studymind/core/finance'

import type { EffectiveRecoverySettings } from './recovery-settings'

export interface CaseVarsInput {
  personName: string | null
  contactFirstName?: string | null
  contactLastName?: string | null
  outstandingMinor: number
  setupLinkUrl: string | null
  /** When chasing started — interest accrues from here. */
  createdAt: Date
}

export interface CaseRecoveryVars {
  vars: RecoveryTemplateVars
  ccj: CcjEstimate
  responseDeadline: Date
}

export function buildCaseRecoveryVars(
  c: CaseVarsInput,
  now: Date,
  settings: EffectiveRecoverySettings,
): CaseRecoveryVars {
  const fullName =
    [c.contactFirstName, c.contactLastName].filter(Boolean).join(' ').trim() || c.personName || null
  const ccj = estimateCcjCosts({
    outstandingMinor: c.outstandingMinor,
    lateFeeMinor: settings.lateFeeMinor,
    overdueSince: c.createdAt,
    now,
  })
  const responseDeadline = new Date(now.getTime() + settings.responseDays * 86_400_000)
  const vars = buildRecoveryVars({
    fullName,
    outstandingMinor: c.outstandingMinor,
    setupLinkUrl: c.setupLinkUrl,
    phone: settings.financePhone,
    ccj,
    responseDeadline,
  })
  return { vars, ccj, responseDeadline }
}
