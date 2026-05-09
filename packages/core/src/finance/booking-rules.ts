// Hours model for the reconciliation triangle.
// CLAUDE.md §6.3 (booking site is source of truth for hours), §6.4 (only
// `delivered` counts toward billed hours), §41.2 (delivery is monotonic;
// once delivered the only valid transition is `corrected_by`).

export type BookingSessionState =
  | 'tentative'
  | 'confirmed'
  | 'delivered'
  | 'no_show'
  | 'cancelled'

export interface BookingSessionRecord {
  id: string
  state: BookingSessionState
  /** Hours actually delivered. Meaningful when state === 'delivered'. */
  deliveredHours: number
  /** If this row is a correction of an earlier session, points to it. */
  correctedSessionId?: string | null
}

/**
 * Sum the delivered hours across a set of sessions. Only sessions in state
 * `delivered` count. Corrections are netted: a correction nets out the
 * original (the original keeps its delivered hours, the correction supplies
 * the netted delta — typically a negative value).
 */
export function countDeliveredHours(sessions: readonly BookingSessionRecord[]): number {
  let total = 0
  for (const s of sessions) {
    if (s.state !== 'delivered') continue
    total += s.deliveredHours
  }
  return total
}

export interface CorrectionInput {
  /** The original session being corrected. Must be in state `delivered`. */
  original: BookingSessionRecord
  /** The replacement session. May supply a delta (typically negative). */
  replacement: BookingSessionRecord
}

export interface CorrectionResult {
  netDeliveredHours: number
}

/**
 * Apply a correction. The replacement's `correctedSessionId` must point to
 * the original. The net delivered-hours figure is `original.deliveredHours +
 * replacement.deliveredHours` — both are summed because the replacement is
 * expected to encode the delta directly (e.g. -2.0 to cancel a 2h session).
 *
 * Throws if the original is not delivered (cannot correct an undelivered
 * session) or the link is wrong.
 */
export function applyCorrection({ original, replacement }: CorrectionInput): CorrectionResult {
  if (original.state !== 'delivered') {
    throw new Error(`Cannot correct session ${original.id} — not delivered`)
  }
  if (replacement.correctedSessionId !== original.id) {
    throw new Error(
      `Replacement ${replacement.id} does not point to original ${original.id}`,
    )
  }
  // Once delivered, the only valid transition is `corrected_by` (§41.2).
  // The replacement is itself either `delivered` (a corrected delivery) or a
  // signal session that nets to zero — we accept both.
  const replacementDelivered =
    replacement.state === 'delivered' ? replacement.deliveredHours : 0
  return { netDeliveredHours: original.deliveredHours + replacementDelivered }
}

/**
 * Guard against an attempt to undeliver a session by direct mutation.
 * Returns true if the proposed transition is legal under §41.2. Pure helper
 * for callers that compare prior state to a fresh booking-site payload.
 */
export function isLegalSessionTransition(
  prev: BookingSessionState,
  next: BookingSessionState,
): boolean {
  if (prev === 'delivered' && next !== 'delivered') return false
  return true
}
