// Missed-calls domain (CLAUDE.md §10). Pure logic — no I/O.
//
// A missed call is an INBOUND call nobody answered (it rang out OR went to
// voicemail). It is "called back" — and so drops off the outstanding list —
// the moment a later OUTBOUND call to the same number exists (any attempt,
// connected or not). That resolution is *derived*, never stored, so calling
// someone back from anywhere auto-resolves with no extra step. A small manual
// override (actioned / dismissed) layers on top for spam or "handled another
// way". The DB-touching aggregation lives in the tRPC router; this module owns
// the dedupe + the state decision so they're unit-testable.

/** One raw `call` Interaction row, projected to the fields we reason about.
 * A single call can produce several rows (one per Aircall event). */
export interface RawCall {
  interactionId: string
  aircallCallId: number | null
  occurredAt: Date
  direction: 'inbound' | 'outbound' | null
  durationSec: number
  isVoicemail: boolean
  rawDigits: string | null
  contactId: string | null
}

/** A call after collapsing its per-event rows into one. */
export interface NormalizedCall {
  /** Stable id: the Aircall call id when present, else the interaction id. */
  callKey: string
  aircallCallId: string | null
  occurredAt: Date
  direction: 'inbound' | 'outbound' | null
  durationSec: number
  isVoicemail: boolean
  rawDigits: string | null
  contactId: string | null
}

export type MissedCallState = 'outstanding' | 'called_back' | 'actioned' | 'dismissed'
export type MissedReviewStatus = 'actioned' | 'dismissed'

export interface MissedCallReviewRow {
  status: MissedReviewStatus
  note: string | null
  reviewedAt: Date
  reviewedById: string | null
}

export interface MissedCallResult extends NormalizedCall {
  state: MissedCallState
  /** When a callback was detected (derived), else null. */
  calledBackAt: Date | null
  review: MissedCallReviewRow | null
}

/** A call counts as answered only if a human picked up (talk time > 0 and it
 * isn't a voicemail). Everything else inbound is a miss to follow up. */
export function isAnswered(c: { durationSec: number; isVoicemail: boolean }): boolean {
  return !c.isVoicemail && c.durationSec > 0
}

/** Collapse per-event call rows into one row per call (dedupe on Aircall id):
 * earliest time, longest duration, voicemail if any event was a voicemail,
 * first known direction / number / contact. */
export function normalizeCalls(rows: ReadonlyArray<RawCall>): NormalizedCall[] {
  const byKey = new Map<string, NormalizedCall>()
  for (const r of rows) {
    const callKey = r.aircallCallId != null ? `ac:${r.aircallCallId}` : `iid:${r.interactionId}`
    const prev = byKey.get(callKey)
    if (!prev) {
      byKey.set(callKey, {
        callKey,
        aircallCallId: r.aircallCallId != null ? String(r.aircallCallId) : null,
        occurredAt: r.occurredAt,
        direction: r.direction,
        durationSec: r.durationSec,
        isVoicemail: r.isVoicemail,
        rawDigits: r.rawDigits,
        contactId: r.contactId,
      })
      continue
    }
    if (r.occurredAt < prev.occurredAt) prev.occurredAt = r.occurredAt
    if (r.durationSec > prev.durationSec) prev.durationSec = r.durationSec
    if (r.isVoicemail) prev.isVoicemail = true
    if (prev.direction == null && r.direction != null) prev.direction = r.direction
    if (!prev.rawDigits && r.rawDigits) prev.rawDigits = r.rawDigits
    if (!prev.contactId && r.contactId) prev.contactId = r.contactId
  }
  return [...byKey.values()]
}

/**
 * Derive the missed-call list with each call's state. `calls` should include
 * BOTH inbound and outbound calls (outbound calls drive the auto-resolution).
 * Resolution precedence: a manual `dismissed` (spam) always wins; otherwise a
 * detected callback; otherwise a manual `actioned`; otherwise outstanding.
 * Result is newest-first.
 */
export function deriveMissedCalls(
  calls: ReadonlyArray<NormalizedCall>,
  reviewsByAircallId: ReadonlyMap<string, MissedCallReviewRow>,
): MissedCallResult[] {
  // Index outbound attempts by number → ascending timestamps.
  const outboundByNumber = new Map<string, number[]>()
  for (const c of calls) {
    if (c.direction === 'outbound' && c.rawDigits) {
      const arr = outboundByNumber.get(c.rawDigits) ?? []
      arr.push(c.occurredAt.getTime())
      outboundByNumber.set(c.rawDigits, arr)
    }
  }
  for (const arr of outboundByNumber.values()) arr.sort((a, b) => a - b)

  const missed = calls.filter((c) => c.direction === 'inbound' && !isAnswered(c))

  return missed
    .map((c): MissedCallResult => {
      let calledBackAt: Date | null = null
      if (c.rawDigits) {
        const times = outboundByNumber.get(c.rawDigits)
        const after = times?.find((t) => t > c.occurredAt.getTime())
        if (after != null) calledBackAt = new Date(after)
      }
      const review = c.aircallCallId ? reviewsByAircallId.get(c.aircallCallId) ?? null : null

      let state: MissedCallState
      if (review?.status === 'dismissed') state = 'dismissed'
      else if (calledBackAt) state = 'called_back'
      else if (review?.status === 'actioned') state = 'actioned'
      else state = 'outstanding'

      return { ...c, state, calledBackAt, review }
    })
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
}

/** Headline counts for the workspace chips. */
export function summariseMissedCalls(results: ReadonlyArray<MissedCallResult>): {
  outstanding: number
  calledBack: number
  actioned: number
  dismissed: number
  total: number
} {
  let outstanding = 0
  let calledBack = 0
  let actioned = 0
  let dismissed = 0
  for (const r of results) {
    if (r.state === 'outstanding') outstanding += 1
    else if (r.state === 'called_back') calledBack += 1
    else if (r.state === 'actioned') actioned += 1
    else dismissed += 1
  }
  return { outstanding, calledBack, actioned, dismissed, total: results.length }
}
