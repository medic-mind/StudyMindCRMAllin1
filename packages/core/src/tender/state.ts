// Tender state machine. See CLAUDE.md §43.1.
//
// States flow: identified → drafting → submitted → shortlisted → awarded
// Terminal failure paths: rejected, withdrawn (allowed from most states).
// Pure function — no I/O. The persistence layer in ./index.ts uses this to
// validate every transition before writing.

export const TENDER_STATES = [
  'identified',
  'drafting',
  'submitted',
  'shortlisted',
  'awarded',
  'rejected',
  'withdrawn',
] as const

export type TenderState = (typeof TENDER_STATES)[number]

/**
 * Legal transitions — explicit table, not derived. A missing entry means the
 * transition is rejected. Terminal states (`awarded`, `rejected`, `withdrawn`)
 * cannot move further.
 */
export const TENDER_TRANSITIONS: Readonly<Record<TenderState, ReadonlyArray<TenderState>>> = {
  identified: ['drafting', 'withdrawn'],
  drafting: ['submitted', 'withdrawn'],
  submitted: ['shortlisted', 'rejected', 'withdrawn'],
  shortlisted: ['awarded', 'rejected', 'withdrawn'],
  awarded: [], // terminal
  rejected: [], // terminal
  withdrawn: [], // terminal
}

export interface InvalidTransition {
  ok: false
  reason: 'illegal_transition' | 'unknown_state'
  from: TenderState
  to: TenderState
}

export interface ValidTransition {
  ok: true
  to: TenderState
}

/**
 * Pure transition validator. Returns the new state on success or a typed
 * failure on rejection. Callers persist on success; they never short-circuit
 * a failure into a write.
 */
export function transitionTender(
  current: TenderState,
  to: TenderState,
): ValidTransition | InvalidTransition {
  const allowed = TENDER_TRANSITIONS[current]
  if (!allowed) {
    return { ok: false, reason: 'unknown_state', from: current, to }
  }
  if (!allowed.includes(to)) {
    return { ok: false, reason: 'illegal_transition', from: current, to }
  }
  return { ok: true, to }
}

export function isTerminalTenderState(state: TenderState): boolean {
  return TENDER_TRANSITIONS[state].length === 0
}
