import { describe, expect, it } from 'vitest'

import {
  callNumberFromPayload,
  deriveMissedCalls,
  isAnswered,
  isVoicemailPayload,
  normalizeCalls,
  projectCallInteraction,
  summariseMissedCalls,
  type MissedCallReviewRow,
  type RawCall,
} from './missed-calls'

function raw(p: Partial<RawCall>): RawCall {
  return {
    interactionId: p.interactionId ?? Math.random().toString(36).slice(2),
    aircallCallId: p.aircallCallId ?? null,
    occurredAt: p.occurredAt ?? new Date('2026-06-01T10:00:00Z'),
    direction: p.direction ?? 'inbound',
    durationSec: p.durationSec ?? 0,
    isVoicemail: p.isVoicemail ?? false,
    // Include answeredAt only when the test sets it (number = answered, null =
    // captured-but-not-answered); leaving it out models a legacy row.
    ...(p.answeredAt !== undefined ? { answeredAt: p.answeredAt } : {}),
    rawDigits: p.rawDigits ?? '+447700900001',
    contactId: p.contactId ?? null,
  }
}

describe('isAnswered', () => {
  it('is true only when picked up and not a voicemail (legacy duration heuristic)', () => {
    expect(isAnswered({ durationSec: 42, isVoicemail: false })).toBe(true)
    expect(isAnswered({ durationSec: 0, isVoicemail: false })).toBe(false)
    expect(isAnswered({ durationSec: 30, isVoicemail: true })).toBe(false)
  })

  it('uses answered_at authoritatively over duration when it was captured', () => {
    // THE BUG: a rung-out call has duration > 0 (Aircall counts ring time) but
    // was never answered — answered_at is null. It must NOT count as answered.
    expect(isAnswered({ durationSec: 25, isVoicemail: false, answeredAt: null })).toBe(false)
    // A genuinely answered call carries a numeric answered_at.
    expect(isAnswered({ durationSec: 210, isVoicemail: false, answeredAt: 1746783545 })).toBe(true)
    // answered_at wins even if duration is 0 for some reason.
    expect(isAnswered({ durationSec: 0, isVoicemail: false, answeredAt: 1746783545 })).toBe(true)
    // A voicemail is never answered, whatever answered_at says.
    expect(isAnswered({ durationSec: 30, isVoicemail: true, answeredAt: null })).toBe(false)
  })

  it('falls back to the duration heuristic for legacy rows (answeredAt absent)', () => {
    expect(isAnswered({ durationSec: 5, isVoicemail: false })).toBe(true)
    expect(isAnswered({ durationSec: 0, isVoicemail: false })).toBe(false)
  })
})

describe('isVoicemailPayload', () => {
  it('detects the voicemail event and a present voicemail url', () => {
    expect(isVoicemailPayload({ aircallEvent: 'call.voicemail_left' })).toBe(true)
    expect(isVoicemailPayload({ voicemailUrl: 'https://s3/vm.mp3' })).toBe(true)
  })
  it('is false for an ordinary or empty payload', () => {
    expect(isVoicemailPayload({ aircallEvent: 'call.ended' })).toBe(false)
    expect(isVoicemailPayload({ voicemailUrl: '' })).toBe(false)
    expect(isVoicemailPayload(null)).toBe(false)
    expect(isVoicemailPayload(undefined)).toBe(false)
  })
})

describe('projectCallInteraction', () => {
  const occurredAt = new Date('2026-06-01T10:00:00Z')

  it('reads direction, duration, number and contact out of the payload', () => {
    const call = projectCallInteraction({
      id: 'int_1',
      occurredAt,
      contactId: 'c_1',
      payload: {
        aircallCallId: 99,
        direction: 'inbound',
        durationSec: 12,
        rawDigits: '+447700900001',
      },
    })
    expect(call).toEqual({
      interactionId: 'int_1',
      aircallCallId: 99,
      occurredAt,
      direction: 'inbound',
      durationSec: 12,
      isVoicemail: false,
      rawDigits: '+447700900001',
      contactId: 'c_1',
    })
  })

  it('falls back to safe defaults on a sparse/garbage payload', () => {
    const call = projectCallInteraction({ id: 'int_2', occurredAt, contactId: null, payload: {} })
    expect(call.aircallCallId).toBeNull()
    expect(call.direction).toBeNull()
    expect(call.durationSec).toBe(0)
    expect(call.isVoicemail).toBe(false)
    expect(call.rawDigits).toBeNull()
  })

  it('reads answered_at as a tri-state (number / null / absent)', () => {
    const base = { occurredAt, contactId: null }
    // Captured number → answered.
    expect(
      projectCallInteraction({ id: 'a', ...base, payload: { answeredAt: 1746783545 } }).answeredAt,
    ).toBe(1746783545)
    // Captured null → known miss.
    expect(projectCallInteraction({ id: 'b', ...base, payload: { answeredAt: null } }).answeredAt).toBe(
      null,
    )
    // Absent (legacy row) → undefined, so isAnswered falls back to duration.
    expect(
      'answeredAt' in projectCallInteraction({ id: 'c', ...base, payload: { durationSec: 9 } }),
    ).toBe(false)
  })

  it('flags a voicemail and uses the toNumber fallback for manual click-to-call', () => {
    const call = projectCallInteraction({
      id: 'int_3',
      occurredAt,
      contactId: null,
      payload: {
        direction: 'outbound',
        toNumber: '07700900002',
        voicemailUrl: 'https://s3/vm.mp3',
      },
    })
    expect(call.direction).toBe('outbound')
    expect(call.isVoicemail).toBe(true)
    expect(call.rawDigits).toBe('07700900002')
  })
})

describe('callNumberFromPayload', () => {
  it('prefers rawDigits (Aircall calls)', () => {
    expect(callNumberFromPayload({ rawDigits: '+447700900001', toNumber: '999' })).toBe(
      '+447700900001',
    )
  })

  it('falls back to toNumber for a manually logged click-to-call', () => {
    // The contact-page Call button / Google Voice callback stores the dialled
    // number at toNumber, never rawDigits — this fallback is what lets such a
    // callback clear a miss by number.
    expect(
      callNumberFromPayload({ event: 'call.manually_logged', toNumber: '+447700900001' }),
    ).toBe('+447700900001')
  })

  it('ignores blank values and returns null when neither is present', () => {
    expect(callNumberFromPayload({ rawDigits: '', toNumber: '   ' })).toBeNull()
    expect(callNumberFromPayload({})).toBeNull()
    expect(callNumberFromPayload(null)).toBeNull()
  })
})

describe('normalizeCalls', () => {
  it('collapses per-event rows for one call (dedupe on aircall id)', () => {
    const rows = [
      raw({ aircallCallId: 1, occurredAt: new Date('2026-06-01T10:00:05Z'), durationSec: 0 }),
      raw({ aircallCallId: 1, occurredAt: new Date('2026-06-01T10:00:00Z'), durationSec: 12 }),
      raw({ aircallCallId: 1, occurredAt: new Date('2026-06-01T10:00:10Z'), isVoicemail: true }),
    ]
    const out = normalizeCalls(rows)
    expect(out).toHaveLength(1)
    expect(out[0]?.occurredAt.toISOString()).toBe('2026-06-01T10:00:00.000Z') // earliest
    expect(out[0]?.durationSec).toBe(12) // max
    expect(out[0]?.isVoicemail).toBe(true) // any
    expect(out[0]?.aircallCallId).toBe('1')
  })

  it('keeps non-aircall calls distinct by interaction id', () => {
    const out = normalizeCalls([
      raw({ interactionId: 'a', aircallCallId: null }),
      raw({ interactionId: 'b', aircallCallId: null }),
    ])
    expect(out).toHaveLength(2)
  })

  it('propagates the answer signal across a call event rows (numeric wins, null upgrades)', () => {
    // One enriched event row carrying answered_at:null flips the collapsed call
    // to a known miss even when the other event rows are legacy (undefined).
    const missed = normalizeCalls([
      raw({ aircallCallId: 5, durationSec: 20 }), // legacy row, no answeredAt
      raw({ aircallCallId: 5, durationSec: 20, answeredAt: null }), // enriched
    ])
    expect(missed[0]?.answeredAt).toBe(null)
    // A numeric answer on any event row wins (the call was picked up).
    const answered = normalizeCalls([
      raw({ aircallCallId: 6, durationSec: 0 }),
      raw({ aircallCallId: 6, durationSec: 200, answeredAt: 1746783545 }),
    ])
    expect(answered[0]?.answeredAt).toBe(1746783545)
  })
})

describe('deriveMissedCalls', () => {
  const noReviews = new Map<string, MissedCallReviewRow>()

  it('flags an unanswered inbound call as outstanding', () => {
    const calls = normalizeCalls([raw({ aircallCallId: 1, durationSec: 0 })])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(1)
    expect(out[0]?.state).toBe('outstanding')
  })

  it('counts a voicemail as a missed call', () => {
    const calls = normalizeCalls([raw({ aircallCallId: 1, isVoicemail: true, durationSec: 8 })])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('does not list an answered inbound call', () => {
    const calls = normalizeCalls([raw({ aircallCallId: 1, durationSec: 60 })])
    expect(deriveMissedCalls(calls, noReviews)).toHaveLength(0)
  })

  it('lists a RUNG-OUT inbound call as a miss even though duration counts ring time', () => {
    // The regression: Aircall reports duration = ring time (> 0) for a call
    // nobody answered, with answered_at null. Duration alone hid it as
    // "answered"; answered_at makes it correctly a miss.
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 22, answeredAt: null }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(1)
    expect(out[0]?.state).toBe('outstanding')
  })

  it('does not list a call answered_at confirms was answered (duration incl. ring)', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 210, answeredAt: 1746783545 }),
    ])
    expect(deriveMissedCalls(calls, noReviews)).toHaveLength(0)
  })

  it('auto-resolves once a later outbound call to the same number exists', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 1,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900111',
      }),
      raw({
        aircallCallId: 2,
        direction: 'outbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T11:00:00Z'),
        rawDigits: '+447700900111',
      }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(1)
    expect(out[0]?.state).toBe('called_back')
    expect(out[0]?.calledBackAt?.toISOString()).toBe('2026-06-01T11:00:00.000Z')
  })

  it('resolves a miss from a later ANSWERED callback that has no clean direction', () => {
    // Hardening: a re-synced/duplicated or manually-logged callback can land
    // without a `direction`. As long as it CONNECTED (answered) to the same
    // number after the miss, the miss must clear and stay cleared — never
    // flicker back to outstanding.
    const calls = normalizeCalls([
      raw({
        aircallCallId: 1,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900111',
      }),
      raw({
        aircallCallId: 2,
        direction: null,
        durationSec: 42,
        occurredAt: new Date('2026-06-01T11:00:00Z'),
        rawDigits: '07700 900111',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('called_back')
  })

  it('resolves via the linked contact when the callback went to a DIFFERENT number', () => {
    // The miss came from the customer's mobile; the agent rang them back on
    // their other number. Both calls link to the same CRM contact, so the
    // miss must still clear.
    const calls = normalizeCalls([
      raw({
        aircallCallId: 30,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900111',
        contactId: 'contact_1',
      }),
      raw({
        aircallCallId: 31,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
        rawDigits: '+442079460000',
        contactId: 'contact_1',
      }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out[0]?.state).toBe('called_back')
    expect(out[0]?.calledBackAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z')
  })

  it('resolves a miss from a manual callback to a DIFFERENT contact, by number', () => {
    // The miss sits on an auto-created lightweight contact; the agent rang the
    // number back from a different (deduplicated) contact's page, so the
    // outbound call links to another contactId. The contact link can't bridge
    // it — only the number can. The manual leg's number reaches the derivation
    // via callNumberFromPayload(toNumber), so this MUST clear.
    const calls = normalizeCalls([
      raw({
        aircallCallId: 40,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900111',
        contactId: 'contact_auto',
      }),
      raw({
        aircallCallId: null,
        interactionId: 'manual_1',
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
        rawDigits: '+447700900111', // router fills this from payload.toNumber
        contactId: 'contact_real',
      }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out[0]?.state).toBe('called_back')
    expect(out[0]?.calledBackAt?.toISOString()).toBe('2026-06-01T10:00:00.000Z')
  })

  it('does not contact-resolve a miss with no linked contact', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 32,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900111',
        contactId: null,
      }),
      raw({
        aircallCallId: 33,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
        rawDigits: '+442079460000',
        contactId: 'contact_1',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('does not resolve from an outbound call BEFORE the miss', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 1,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T08:00:00Z'),
        rawDigits: '+447700900222',
      }),
      raw({
        aircallCallId: 2,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900222',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('resolves a callback even when the two legs are formatted differently', () => {
    // Inbound miss carries a spaced raw_digits; the click-to-call'd outbound
    // leg comes back E.164-tight. Same person — must still resolve.
    const calls = normalizeCalls([
      raw({
        aircallCallId: 10,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+44 7700 900555',
      }),
      raw({
        aircallCallId: 11,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T13:00:00Z'),
        rawDigits: '+447700900555',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('called_back')
  })

  it('resolves a callback across national-vs-E.164 formatting', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 12,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900666',
      }),
      raw({
        aircallCallId: 13,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T13:00:00Z'),
        rawDigits: '07700 900666',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('called_back')
  })

  it('resolves when the customer rings again later and is ANSWERED', () => {
    // No outbound leg, but the same number got through on a second attempt —
    // the loop is closed, the miss must not stay outstanding.
    const calls = normalizeCalls([
      raw({
        aircallCallId: 20,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900777',
      }),
      raw({
        aircallCallId: 21,
        direction: 'inbound',
        durationSec: 95,
        occurredAt: new Date('2026-06-01T12:06:00Z'),
        rawDigits: '+447700900777',
      }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(1) // the answered call is not itself a miss
    expect(out[0]?.state).toBe('called_back')
    expect(out[0]?.calledBackAt?.toISOString()).toBe('2026-06-01T12:06:00.000Z')
  })

  it('does NOT resolve from a later inbound call that also rang out', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 22,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900888',
      }),
      raw({
        aircallCallId: 23,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T10:00:00Z'),
        rawDigits: '+447700900888',
      }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(2)
    expect(out.every((c) => c.state === 'outstanding')).toBe(true)
  })

  it('does not cross-resolve between different numbers', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 1,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900333',
      }),
      raw({
        aircallCallId: 2,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T11:00:00Z'),
        rawDigits: '+447700900999',
      }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('honours a manual actioned override', () => {
    const calls = normalizeCalls([raw({ aircallCallId: 7, durationSec: 0 })])
    const reviews = new Map<string, MissedCallReviewRow>([
      [
        '7',
        { status: 'actioned', note: 'texted them', reviewedAt: new Date(), reviewedById: 'u1' },
      ],
    ])
    expect(deriveMissedCalls(calls, reviews)[0]?.state).toBe('actioned')
  })

  it('keeps a dismissed (spam) call dismissed even if a later outbound exists', () => {
    const calls = normalizeCalls([
      raw({
        aircallCallId: 8,
        direction: 'inbound',
        durationSec: 0,
        occurredAt: new Date('2026-06-01T09:00:00Z'),
        rawDigits: '+447700900444',
      }),
      raw({
        aircallCallId: 9,
        direction: 'outbound',
        occurredAt: new Date('2026-06-01T12:00:00Z'),
        rawDigits: '+447700900444',
      }),
    ])
    const reviews = new Map<string, MissedCallReviewRow>([
      ['8', { status: 'dismissed', note: null, reviewedAt: new Date(), reviewedById: 'u1' }],
    ])
    expect(deriveMissedCalls(calls, reviews)[0]?.state).toBe('dismissed')
  })

  it('summarises counts by state', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 0, rawDigits: '+447700900001' }),
      raw({
        aircallCallId: 2,
        direction: 'inbound',
        durationSec: 0,
        rawDigits: '+447700900002',
        occurredAt: new Date('2026-06-01T09:00:00Z'),
      }),
      raw({
        aircallCallId: 3,
        direction: 'outbound',
        rawDigits: '+447700900002',
        occurredAt: new Date('2026-06-01T10:00:00Z'),
      }),
    ])
    const summary = summariseMissedCalls(deriveMissedCalls(calls, noReviews))
    expect(summary.total).toBe(2)
    expect(summary.outstanding).toBe(1)
    expect(summary.calledBack).toBe(1)
  })
})
