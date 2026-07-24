// Slack → Complaints auto-ingestion was removed (2026-07). A Slack message must
// NEVER open a Complaint row anymore — complaints are logged in the CRM.

import { describe, expect, it } from 'vitest'

import { maybeRaiseComplaintFromSlack } from './complaints'

describe('maybeRaiseComplaintFromSlack (removed — no-op)', () => {
  it('never raises a complaint, whatever the message/channel', async () => {
    const res = await maybeRaiseComplaintFromSlack({
      contactId: 'c1',
      channelId: 'C1',
      channelName: 'complaintcallsummaries',
      slackTs: '1700000000.000100',
      messageText: 'Parent unhappy — wants a refund.',
      occurredAt: new Date('2026-07-20T10:00:00.000Z'),
    })
    expect(res).toEqual({ raised: false, complaintId: null })
  })
})
