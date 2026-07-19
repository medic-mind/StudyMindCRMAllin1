// Build the token values for a Direct Debit recovery message from a case's live
// figures (ADR 0045 amendment). One place so the automated engine and the
// manual send show the customer the SAME numbers — including the calculated
// CCJ court fee + statutory interest for the letter-before-claim steps.
//
// The CCJ figures are always computed and passed; only templates that reference
// {{court_fee}} / {{interest}} / {{total_with_costs}} (the stern / CCJ steps)
// actually show them, so the gentle reminders stay gentle.

import {
  buildRecoveryVars,
  DEBT_LETTER_RESPONSE_DAYS,
  estimateCcjCosts,
  resolveDdLateFeeMinor,
  type CcjEstimate,
  type RecoveryTemplateVars,
} from '@studymind/core/finance'

/** StudyMind finance contact number shown in the letters. Overridable. */
const FINANCE_PHONE = process.env.DD_FINANCE_PHONE ?? '020 3305 9593'

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

export function buildCaseRecoveryVars(c: CaseVarsInput, now: Date): CaseRecoveryVars {
  const fullName =
    [c.contactFirstName, c.contactLastName].filter(Boolean).join(' ').trim() || c.personName || null
  const lateFeeMinor = resolveDdLateFeeMinor(process.env.DD_LATE_FEE_GBP)
  const ccj = estimateCcjCosts({
    outstandingMinor: c.outstandingMinor,
    lateFeeMinor,
    overdueSince: c.createdAt,
    now,
  })
  const responseDeadline = new Date(now.getTime() + DEBT_LETTER_RESPONSE_DAYS * 86_400_000)
  const vars = buildRecoveryVars({
    fullName,
    outstandingMinor: c.outstandingMinor,
    setupLinkUrl: c.setupLinkUrl,
    phone: FINANCE_PHONE,
    ccj,
    responseDeadline,
  })
  return { vars, ccj, responseDeadline }
}
