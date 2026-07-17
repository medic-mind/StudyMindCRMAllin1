import { describe, expect, it } from 'vitest'

import {
  buildComplaintDraft,
  COMPLAINT_AUTO_RAISE_HORIZON_MS,
  isComplaintChannel,
  shouldAutoRaiseComplaint,
} from './channel-rules'

describe('isComplaintChannel', () => {
  it('matches any channel whose name contains "complaint"', () => {
    expect(isComplaintChannel('complaintcallsummaries')).toBe(true)
    expect(isComplaintChannel('#complaintcallsummaries')).toBe(true)
    expect(isComplaintChannel('b2bcomplaints')).toBe(true)
    expect(isComplaintChannel('Complaint-Escalations')).toBe(true)
  })

  it('rejects everything else (incl. unresolved names)', () => {
    expect(isComplaintChannel('callsummaries')).toBe(false)
    expect(isComplaintChannel('crm-alerts')).toBe(false)
    expect(isComplaintChannel(null)).toBe(false)
    expect(isComplaintChannel(undefined)).toBe(false)
    expect(isComplaintChannel('')).toBe(false)
  })
})

describe('shouldAutoRaiseComplaint', () => {
  const now = new Date('2026-07-17T12:00:00Z')
  const fresh = new Date('2026-07-16T12:00:00Z')

  it('raises for a fresh, contact-linked mention in a complaint channel', () => {
    expect(
      shouldAutoRaiseComplaint({
        channelName: 'complaintcallsummaries',
        contactId: 'c1',
        occurredAt: fresh,
        now,
      }),
    ).toBe(true)
  })

  it('never raises outside a complaint channel', () => {
    expect(
      shouldAutoRaiseComplaint({
        channelName: 'callsummaries',
        contactId: 'c1',
        occurredAt: fresh,
        now,
      }),
    ).toBe(false)
  })

  it('never raises without a contact (account-only mentions have nobody to log against)', () => {
    expect(
      shouldAutoRaiseComplaint({
        channelName: 'complaintcallsummaries',
        contactId: null,
        occurredAt: fresh,
        now,
      }),
    ).toBe(false)
  })

  it('never raises past the horizon — backfills must not flood the queue', () => {
    const ancient = new Date(now.getTime() - COMPLAINT_AUTO_RAISE_HORIZON_MS - 1)
    expect(
      shouldAutoRaiseComplaint({
        channelName: 'complaintcallsummaries',
        contactId: 'c1',
        occurredAt: ancient,
        now,
      }),
    ).toBe(false)
  })

  it('tolerates clock skew (occurredAt slightly in the future)', () => {
    expect(
      shouldAutoRaiseComplaint({
        channelName: 'complaintcallsummaries',
        contactId: 'c1',
        occurredAt: new Date(now.getTime() + 60_000),
        now,
      }),
    ).toBe(true)
  })
})

describe('buildComplaintDraft', () => {
  it('titles from the first line with Slack markup unwrapped and emoji codes stripped', () => {
    const draft = buildComplaintDraft({
      messageText:
        ':gb:Aviral Sethi <tel:+4407818953024|+4407818953024> Medic Mind\n' +
        '• Medicine Interview for NALHN in Adelaide, Australia\n' +
        '• Would like to know if we are offering support',
      aiCategory: null,
    })
    expect(draft.title).toBe('Aviral Sethi +4407818953024 Medic Mind')
    expect(draft.description).toContain('Medicine Interview for NALHN')
    expect(draft.category).toBeNull()
  })

  it('maps known AI categories to complaint presets, unknown to null', () => {
    expect(buildComplaintDraft({ messageText: 'x y', aiCategory: 'billing' }).category).toBe(
      'Billing',
    )
    expect(buildComplaintDraft({ messageText: 'x y', aiCategory: 'scheduling' }).category).toBe(
      'Scheduling',
    )
    expect(buildComplaintDraft({ messageText: 'x y', aiCategory: 'complaint' }).category).toBeNull()
  })

  it('falls back to a stock title for an all-markup message', () => {
    expect(buildComplaintDraft({ messageText: ':gb:', aiCategory: null }).title).toBe(
      'Complaint call summary (Slack)',
    )
  })
})
