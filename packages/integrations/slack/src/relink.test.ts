import { describe, expect, it } from 'vitest'

import { candidateFromParsed, isUnrescuableParkedRow, resolveUnlinkedOutcome } from './relink'

const NO_CANDIDATE = { name: null, email: null, phone: null }
const NO_SIGNALS = { email: null, phone: null }

const SUBSTANTIVE_NAMELESS = {
  candidate: NO_CANDIDATE,
  messageText: 'Customer is very unhappy about the refund, please advise urgently',
  extractedNames: [] as string[],
  textSignals: NO_SIGNALS,
}
const UNRESCUABLE = {
  candidate: NO_CANDIDATE,
  messageText: '👍',
  extractedNames: [] as string[],
  textSignals: NO_SIGNALS,
}

describe('candidateFromParsed', () => {
  it('reads the stored slack-summary extraction', () => {
    const c = candidateFromParsed({
      candidateContactIdentifier: { name: 'Aanya Patel', email: null, phone: '07700 900123' },
      summary: 'Wants to book UCAT tutoring',
      category: 'sales',
      sentiment: 'positive',
      suggestedNextAction: 'Send pricing',
      confidence: 0.6,
      promptVersion: '2026-06-11.1',
    })
    expect(c).toMatchObject({
      name: 'Aanya Patel',
      email: null,
      phone: '07700 900123',
      summary: 'Wants to book UCAT tutoring',
      category: 'sales',
      promptVersion: '2026-06-11.1',
    })
  })

  it('is defensive about missing / blank fields', () => {
    expect(candidateFromParsed({})).toEqual({
      name: null,
      email: null,
      phone: null,
      summary: null,
      category: null,
      sentiment: null,
      suggestedNextAction: null,
      promptVersion: null,
    })
    expect(candidateFromParsed(null).name).toBeNull()
    expect(candidateFromParsed({ candidateContactIdentifier: { name: '  ' } }).name).toBeNull()
  })
})

describe('isUnrescuableParkedRow', () => {
  it('dismisses a row with no identity and empty text', () => {
    expect(
      isUnrescuableParkedRow({
        candidate: NO_CANDIDATE,
        messageText: null,
        extractedNames: [],
        textSignals: NO_SIGNALS,
      }),
    ).toBe(true)
  })

  it('dismisses a row with no identity and pure-noise text', () => {
    for (const messageText of ['thanks', '👍', 'ok']) {
      expect(
        isUnrescuableParkedRow({
          candidate: NO_CANDIDATE,
          messageText,
          extractedNames: [],
          textSignals: NO_SIGNALS,
        }),
      ).toBe(true)
    }
  })

  it('KEEPS a substantive but nameless message for a human (never auto-dismisses real work)', () => {
    expect(
      isUnrescuableParkedRow({
        candidate: NO_CANDIDATE,
        messageText: 'Customer is very unhappy about the refund, please advise urgently',
        extractedNames: [],
        textSignals: NO_SIGNALS,
      }),
    ).toBe(false)
  })

  it('KEEPS a row that still has something to match on (candidate, name, or signal)', () => {
    expect(
      isUnrescuableParkedRow({
        candidate: { name: 'Paula Baker', email: null, phone: null },
        messageText: 'ok',
        extractedNames: [],
        textSignals: NO_SIGNALS,
      }),
    ).toBe(false)
    expect(
      isUnrescuableParkedRow({
        candidate: NO_CANDIDATE,
        messageText: 'ok',
        extractedNames: ['Paula Baker'],
        textSignals: NO_SIGNALS,
      }),
    ).toBe(false)
    expect(
      isUnrescuableParkedRow({
        candidate: NO_CANDIDATE,
        messageText: 'ok',
        extractedNames: [],
        textSignals: { email: 'paula@example.com', phone: null },
      }),
    ).toBe(false)
  })
})

describe('resolveUnlinkedOutcome (tray policy)', () => {
  it('full-auto ON: dismisses a substantive nameless row (no human queue)', () => {
    expect(resolveUnlinkedOutcome(true, SUBSTANTIVE_NAMELESS)).toEqual({
      dismiss: true,
      reason: 'auto_dismiss_unlinked',
    })
  })

  it('full-auto OFF: keeps a substantive nameless row for a human (§3)', () => {
    expect(resolveUnlinkedOutcome(false, SUBSTANTIVE_NAMELESS)).toEqual({
      dismiss: false,
      reason: null,
    })
  })

  it('always dismisses an unrescuable row, regardless of mode', () => {
    expect(resolveUnlinkedOutcome(true, UNRESCUABLE)).toEqual({
      dismiss: true,
      reason: 'unrescuable',
    })
    expect(resolveUnlinkedOutcome(false, UNRESCUABLE)).toEqual({
      dismiss: true,
      reason: 'unrescuable',
    })
  })
})
