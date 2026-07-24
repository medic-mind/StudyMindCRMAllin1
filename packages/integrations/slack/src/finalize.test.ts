// Unit tests for the ingest-time finalizer. The behaviour that matters: a Slack
// mention the matcher couldn't resolve is recorded for the archive AND, in
// full-auto (the default), resolved in the same write so it NEVER enters the
// human triage queue — the fix for "new mentions keep being added to the tray
// for someone to assign by hand". db + audit are mocked so this stays a pure
// unit test of the finalize decision + write.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findUnique, upsert, writeAudit } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  upsert: vi.fn(),
  writeAudit: vi.fn(),
}))

vi.mock('@studymind/db', () => ({
  db: {
    unassignedSummary: { findUnique, upsert },
  },
}))
vi.mock('@studymind/audit', () => ({ writeAuditLogEntry: writeAudit }))

import {
  candidateIdentityFromParsed,
  finalizeUnresolvedMention,
  isUnrescuableParkedRow,
  resolveUnlinkedOutcome,
} from './finalize'

const NAMELESS_PARSED = {
  candidateContactIdentifier: { name: null, email: null, phone: null },
  summary: 'Customer is unhappy about the refund, please advise',
  category: 'general',
  sentiment: 'neutral',
  confidence: 0,
}

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    slackTs: '1700000000.000100',
    channelId: 'C0FEED',
    channelName: 'ops-queries',
    parsed: NAMELESS_PARSED,
    confidence: 0,
    messageText: 'Customer is unhappy about the refund, please advise',
    senderName: 'Aisha',
    extractedNames: [] as string[],
    textSignals: { email: null, phone: null },
    actorId: null,
    requestId: 'req-1',
    ...overrides,
  }
}

beforeEach(() => {
  findUnique.mockReset().mockResolvedValue(null)
  upsert.mockReset().mockResolvedValue({ id: 'row-new' })
  writeAudit.mockReset().mockResolvedValue(undefined)
  delete process.env['SLACK_TRAY_FULL_AUTO']
})

afterEach(() => {
  delete process.env['SLACK_TRAY_FULL_AUTO']
})

describe('candidateIdentityFromParsed', () => {
  it('reads the AI/deterministic identity guess, trimming blanks', () => {
    expect(
      candidateIdentityFromParsed({
        candidateContactIdentifier: { name: '  Priya Patel ', email: '', phone: '07700 900123' },
      }),
    ).toEqual({ name: 'Priya Patel', email: null, phone: '07700 900123' })
    expect(candidateIdentityFromParsed(null)).toEqual({ name: null, email: null, phone: null })
  })
})

describe('finalizeUnresolvedMention — full-auto (default)', () => {
  it('records AND resolves an unmatched mention in one write, so it never queues', async () => {
    const res = await finalizeUnresolvedMention(baseInput())
    expect(res).toEqual({ parked: false, dismissed: true })
    // A single atomic upsert whose CREATE branch is already resolved.
    expect(upsert).toHaveBeenCalledTimes(1)
    const args = upsert.mock.calls[0]![0]
    expect(args.create.resolvedAt).toBeInstanceOf(Date)
    expect(args.create.slackTs).toBe('1700000000.000100')
    // The update branch also (re)sets resolvedAt so a concurrent open row is
    // resolved too, and never re-opens one.
    expect(args.update.resolvedAt).toBeInstanceOf(Date)
    // And the dismissal is audited.
    expect(writeAudit).toHaveBeenCalledTimes(1)
    expect(writeAudit.mock.calls[0]![1]).toMatchObject({
      action: 'slack_summary.dismissed',
      after: { auto: true, atIngest: true },
    })
  })

  it('resolves a substantive nameless mention too (auto_dismiss_unlinked)', async () => {
    await finalizeUnresolvedMention(baseInput())
    expect(writeAudit.mock.calls[0]![1].after.reason).toBe('auto_dismiss_unlinked')
  })

  it('is idempotent: an already-resolved row is left alone (no write, no audit)', async () => {
    findUnique.mockResolvedValue({ resolvedAt: new Date() })
    const res = await finalizeUnresolvedMention(baseInput())
    expect(res).toEqual({ parked: false, dismissed: false })
    expect(upsert).not.toHaveBeenCalled()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('resolves an existing OPEN row via the upsert update branch', async () => {
    findUnique.mockResolvedValue({ resolvedAt: null })
    upsert.mockResolvedValue({ id: 'rowOpen' })
    const res = await finalizeUnresolvedMention(baseInput())
    expect(res).toEqual({ parked: false, dismissed: true })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0]![0].update.resolvedAt).toBeInstanceOf(Date)
    expect(writeAudit).toHaveBeenCalledTimes(1)
    expect(writeAudit.mock.calls[0]![1].target).toMatchObject({ id: 'rowOpen' })
  })
})

describe('finalizeUnresolvedMention — kill-switch off (SLACK_TRAY_FULL_AUTO=off)', () => {
  beforeEach(() => {
    process.env['SLACK_TRAY_FULL_AUTO'] = 'off'
  })

  it('keeps a substantive nameless mention OPEN for a human', async () => {
    const res = await finalizeUnresolvedMention(baseInput())
    expect(res).toEqual({ parked: true, dismissed: false })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(upsert.mock.calls[0]![0].create.resolvedAt).toBeNull()
    // The update branch must NOT set resolvedAt (never resolve an open row when
    // the kill-switch keeps nameless rows for a human).
    expect(upsert.mock.calls[0]![0].update.resolvedAt).toBeUndefined()
    expect(writeAudit).not.toHaveBeenCalled()
  })

  it('still dismisses an unrescuable (noise, no identity) mention', async () => {
    const res = await finalizeUnresolvedMention(
      baseInput({ messageText: '👍', parsed: { candidateContactIdentifier: {}, confidence: 0 } }),
    )
    expect(res).toEqual({ parked: false, dismissed: true })
    expect(upsert.mock.calls[0]![0].create.resolvedAt).toBeInstanceOf(Date)
    expect(writeAudit.mock.calls[0]![1].after.reason).toBe('unrescuable')
  })

  it('keeps a mention OPEN when the text carries a name candidate (rescuable later)', async () => {
    const res = await finalizeUnresolvedMention(
      baseInput({ messageText: 'spoke to Jordan', extractedNames: ['Jordan Blake'] }),
    )
    expect(res).toEqual({ parked: true, dismissed: false })
    expect(upsert.mock.calls[0]![0].create.resolvedAt).toBeNull()
  })
})

// Guard the moved pure helpers still behave (they are re-exported from ./relink
// for back-compat; relink.test.ts covers that surface).
describe('pure decision helpers', () => {
  it('isUnrescuableParkedRow flags a noise-only nameless row', () => {
    expect(
      isUnrescuableParkedRow({
        candidate: { name: null, email: null, phone: null },
        messageText: '👍',
        extractedNames: [],
        textSignals: { email: null, phone: null },
      }),
    ).toBe(true)
  })

  it('resolveUnlinkedOutcome dismisses everything in full-auto', () => {
    expect(
      resolveUnlinkedOutcome(true, {
        candidate: { name: null, email: null, phone: null },
        messageText: 'a real substantive note about a customer',
        extractedNames: [],
        textSignals: { email: null, phone: null },
      }),
    ).toEqual({ dismiss: true, reason: 'auto_dismiss_unlinked' })
  })
})
