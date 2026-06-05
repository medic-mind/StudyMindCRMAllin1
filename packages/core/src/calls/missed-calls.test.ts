import { describe, expect, it } from 'vitest'

import {
  deriveMissedCalls,
  isAnswered,
  normalizeCalls,
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
    rawDigits: p.rawDigits ?? '+447700900001',
    contactId: p.contactId ?? null,
  }
}

describe('isAnswered', () => {
  it('is true only when picked up and not a voicemail', () => {
    expect(isAnswered({ durationSec: 42, isVoicemail: false })).toBe(true)
    expect(isAnswered({ durationSec: 0, isVoicemail: false })).toBe(false)
    expect(isAnswered({ durationSec: 30, isVoicemail: true })).toBe(false)
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

  it('auto-resolves once a later outbound call to the same number exists', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 0, occurredAt: new Date('2026-06-01T09:00:00Z'), rawDigits: '+447700900111' }),
      raw({ aircallCallId: 2, direction: 'outbound', durationSec: 0, occurredAt: new Date('2026-06-01T11:00:00Z'), rawDigits: '+447700900111' }),
    ])
    const out = deriveMissedCalls(calls, noReviews)
    expect(out).toHaveLength(1)
    expect(out[0]?.state).toBe('called_back')
    expect(out[0]?.calledBackAt?.toISOString()).toBe('2026-06-01T11:00:00.000Z')
  })

  it('does not resolve from an outbound call BEFORE the miss', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'outbound', occurredAt: new Date('2026-06-01T08:00:00Z'), rawDigits: '+447700900222' }),
      raw({ aircallCallId: 2, direction: 'inbound', durationSec: 0, occurredAt: new Date('2026-06-01T09:00:00Z'), rawDigits: '+447700900222' }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('does not cross-resolve between different numbers', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 0, occurredAt: new Date('2026-06-01T09:00:00Z'), rawDigits: '+447700900333' }),
      raw({ aircallCallId: 2, direction: 'outbound', occurredAt: new Date('2026-06-01T11:00:00Z'), rawDigits: '+447700900999' }),
    ])
    expect(deriveMissedCalls(calls, noReviews)[0]?.state).toBe('outstanding')
  })

  it('honours a manual actioned override', () => {
    const calls = normalizeCalls([raw({ aircallCallId: 7, durationSec: 0 })])
    const reviews = new Map<string, MissedCallReviewRow>([
      ['7', { status: 'actioned', note: 'texted them', reviewedAt: new Date(), reviewedById: 'u1' }],
    ])
    expect(deriveMissedCalls(calls, reviews)[0]?.state).toBe('actioned')
  })

  it('keeps a dismissed (spam) call dismissed even if a later outbound exists', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 8, direction: 'inbound', durationSec: 0, occurredAt: new Date('2026-06-01T09:00:00Z'), rawDigits: '+447700900444' }),
      raw({ aircallCallId: 9, direction: 'outbound', occurredAt: new Date('2026-06-01T12:00:00Z'), rawDigits: '+447700900444' }),
    ])
    const reviews = new Map<string, MissedCallReviewRow>([
      ['8', { status: 'dismissed', note: null, reviewedAt: new Date(), reviewedById: 'u1' }],
    ])
    expect(deriveMissedCalls(calls, reviews)[0]?.state).toBe('dismissed')
  })

  it('summarises counts by state', () => {
    const calls = normalizeCalls([
      raw({ aircallCallId: 1, direction: 'inbound', durationSec: 0, rawDigits: '+447700900001' }),
      raw({ aircallCallId: 2, direction: 'inbound', durationSec: 0, rawDigits: '+447700900002', occurredAt: new Date('2026-06-01T09:00:00Z') }),
      raw({ aircallCallId: 3, direction: 'outbound', rawDigits: '+447700900002', occurredAt: new Date('2026-06-01T10:00:00Z') }),
    ])
    const summary = summariseMissedCalls(deriveMissedCalls(calls, noReviews))
    expect(summary.total).toBe(2)
    expect(summary.outstanding).toBe(1)
    expect(summary.calledBack).toBe(1)
  })
})
