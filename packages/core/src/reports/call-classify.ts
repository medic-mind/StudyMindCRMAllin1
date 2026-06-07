// Classifies a stored `call` Interaction payload into the fields the Aircall
// report needs to (a) bucket the row under the right provider and (b) dedupe
// the several rows that can describe ONE real call down to a single call.
//
// The dedupe key matters. The Aircall webhook writes one Interaction per
// call.* lifecycle event (`call.created`, `call.answered`, `call.ended`, …),
// and the historic backfill / 10-min sync write their own row too — all
// sharing the same Aircall call id. Aircall call ids are NUMERIC, so every
// writer persists `payload.aircallCallId` as a JSON number. We therefore
// accept a number OR a string here: a previous `typeof === 'string'` check
// treated every Aircall call as id-less, which both misfiled them all as
// `manual` AND, by falling back to a timestamp-based key, counted one call
// several times — its duration-0 lifecycle events even inflating the "missed"
// tally. CLAUDE.md §10.

export type CallProvider = 'aircall' | 'google_voice' | 'manual'

export interface ClassifiedCall {
  /** Stable Aircall call id as a string, or null for non-Aircall calls. */
  aircallId: string | null
  provider: CallProvider
  /** Dedupe key: the Aircall id when present, else provider + timestamp. */
  callId: string
}

/**
 * Coerce a stored `aircallCallId` (a JSON number on the wire, occasionally a
 * string) into a stable string key. Returns null when absent or unusable.
 */
export function readAircallCallId(value: unknown): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

export function classifyStoredCall(
  payload: Record<string, unknown> | null | undefined,
  occurredAt: Date,
): ClassifiedCall {
  const p = payload ?? {}
  const aircallId = readAircallCallId(p['aircallCallId'])
  const providerRaw = typeof p['provider'] === 'string' ? p['provider'] : null
  const provider: CallProvider =
    providerRaw === 'google_voice'
      ? 'google_voice'
      : providerRaw === 'manual'
        ? 'manual'
        : aircallId
          ? 'aircall'
          : 'manual'
  const callId = aircallId ?? `${provider}:${occurredAt.toISOString()}`
  return { aircallId, provider, callId }
}
