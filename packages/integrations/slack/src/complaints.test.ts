// Gate test for the Slack → Complaints auto-raise. The behaviour that matters
// here: only a thread's STARTING message opens a complaint. A reply is the
// follow-up conversation and must NOT spawn its own complaint (which used to
// create one per reply, each mis-attributed to whoever the reply named). db,
// audit, logger and the contact matcher are mocked so this stays a pure unit
// test of the gate.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { complaintFindUnique, complaintCreate, interactionCreate, writeAudit, matchContact } =
  vi.hoisted(() => ({
    complaintFindUnique: vi.fn(),
    complaintCreate: vi.fn(),
    interactionCreate: vi.fn(),
    writeAudit: vi.fn(),
    matchContact: vi.fn(),
  }))

vi.mock('@studymind/db', () => ({
  db: {
    complaint: { findUnique: complaintFindUnique, create: complaintCreate },
    interaction: { create: interactionCreate },
  },
}))
vi.mock('@studymind/audit', () => ({ writeAuditLogEntry: writeAudit }))
vi.mock('@studymind/core/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))
vi.mock('./match', () => ({ matchContactByCandidate: matchContact }))

import { maybeRaiseComplaintFromSlack } from './complaints'

const NOW = new Date('2026-07-20T10:00:00.000Z')

beforeEach(() => {
  complaintFindUnique.mockReset().mockResolvedValue(null)
  complaintCreate.mockReset().mockResolvedValue({})
  interactionCreate.mockReset().mockResolvedValue({})
  writeAudit.mockReset().mockResolvedValue(undefined)
  matchContact.mockReset().mockResolvedValue({ contactId: null, via: null, reason: 'no_match' })
})

describe('maybeRaiseComplaintFromSlack — only the thread root raises', () => {
  it('does NOT open a complaint for a thread reply', async () => {
    const res = await maybeRaiseComplaintFromSlack({
      contactId: 'c1',
      channelId: 'C1',
      channelName: 'complaintcallsummaries',
      slackTs: '1700000005.000200',
      messageText: 'Called them back — all sorted now.',
      occurredAt: NOW,
      now: NOW,
      isThreadReply: true,
    })
    expect(res).toEqual({ raised: false, complaintId: null })
    // Short-circuits before any DB work.
    expect(complaintFindUnique).not.toHaveBeenCalled()
    expect(complaintCreate).not.toHaveBeenCalled()
  })

  it('opens ONE complaint for the thread starting message', async () => {
    const res = await maybeRaiseComplaintFromSlack({
      contactId: 'c1',
      channelId: 'C1',
      channelName: 'complaintcallsummaries',
      slackTs: '1700000000.000100',
      messageText: 'Parent unhappy with the last lesson and wants a refund.',
      occurredAt: NOW,
      now: NOW,
      isThreadReply: false,
    })
    expect(res.raised).toBe(true)
    expect(complaintCreate).toHaveBeenCalledTimes(1)
    const arg = complaintCreate.mock.calls[0]?.[0] as { data: Record<string, unknown> }
    expect(arg.data.contactId).toBe('c1')
    expect(arg.data.sourceKey).toBe('slack:C1:1700000000.000100')
  })

  it('treats a missing isThreadReply flag as a root (raises)', async () => {
    const res = await maybeRaiseComplaintFromSlack({
      contactId: 'c1',
      channelId: 'C1',
      channelName: 'b2bcomplaints',
      slackTs: '1700000000.000900',
      messageText: 'Complaint about repeated scheduling errors.',
      occurredAt: NOW,
      now: NOW,
    })
    expect(res.raised).toBe(true)
    expect(complaintCreate).toHaveBeenCalledTimes(1)
  })

  it('still ignores a reply even in a complaint channel with a live timestamp', async () => {
    const res = await maybeRaiseComplaintFromSlack({
      contactId: 'c1',
      channelId: 'C1',
      channelName: '#complaint-escalations',
      slackTs: '1700000009.000300',
      messageText: 'Neslie is picking this up.',
      occurredAt: NOW,
      now: NOW,
      isThreadReply: true,
    })
    expect(res.raised).toBe(false)
    expect(complaintCreate).not.toHaveBeenCalled()
  })
})
