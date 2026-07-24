import { describe, expect, it } from 'vitest'

import { isCallSummaryChannelName, looksLikeCallSummary } from './call-summary-detect'

describe('isCallSummaryChannelName', () => {
  it('matches call-summary channels, excludes complaint channels', () => {
    expect(isCallSummaryChannelName('callsummaries')).toBe(true)
    expect(isCallSummaryChannelName('#anzcallsummaries')).toBe(true)
    expect(isCallSummaryChannelName('complaintcallsummaries')).toBe(false)
    expect(isCallSummaryChannelName('general')).toBe(false)
    expect(isCallSummaryChannelName(null)).toBe(false)
  })
})

describe('looksLikeCallSummary', () => {
  it('recognises a message from a call-summary channel regardless of text', () => {
    expect(looksLikeCallSummary({ text: 'anything', channelName: 'callsummaries' })).toBe(true)
  })

  it('recognises the labelled call-log format in ANY channel', () => {
    const text = [
      'Client Name and Number: Waqara Ali (+447852544479)',
      'Client Email: waqara@example.com',
      'Hours Booked: 20h',
      'Summary of call: discussed the UCAT timetable',
      'Actions: send the pricing PDF',
    ].join('\n')
    expect(looksLikeCallSummary({ text, channelName: 'ops' })).toBe(true)
  })

  it('recognises explicit call-outcome language in a generic channel', () => {
    expect(looksLikeCallSummary({ text: 'Called twice, no answer — left a voicemail', channelName: 'ops' })).toBe(true)
    expect(looksLikeCallSummary({ text: 'Call completed, parent happy with the plan', channelName: 'team' })).toBe(true)
    expect(looksLikeCallSummary({ text: 'Rang out, will try again tomorrow', channelName: 'x' })).toBe(true)
  })

  it('treats a plain mention as NOT a call summary', () => {
    expect(looksLikeCallSummary({ text: "Aanya's account is set up on the portal", channelName: 'ops' })).toBe(false)
    expect(looksLikeCallSummary({ text: 'FYI this family is on the ANZ pipeline', channelName: 'sales' })).toBe(false)
    expect(looksLikeCallSummary({ text: '', channelName: 'ops' })).toBe(false)
    expect(looksLikeCallSummary({ text: null, channelName: null })).toBe(false)
  })

  it('a complaint-channel post is NOT a call summary (it becomes a Complaint)', () => {
    // Even with the labelled format, a complaint channel routes to Complaints.
    expect(
      looksLikeCallSummary({ text: 'Client Email: x@y.com', channelName: 'complaintcallsummaries' }),
    ).toBe(false)
  })
})
