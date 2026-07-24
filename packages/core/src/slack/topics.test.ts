import { describe, expect, it } from 'vitest'

import {
  getTopicDefaultChannelName,
  isSlackTopic,
  normaliseSlackChannelName,
  slackChannelNameMatches,
} from './topics'

describe('normaliseSlackChannelName', () => {
  it('drops a leading hash, lowercases, and strips punctuation', () => {
    expect(normaliseSlackChannelName('#Complaint-Call_Summaries')).toBe('complaintcallsummaries')
    expect(normaliseSlackChannelName('complaint call summaries')).toBe('complaintcallsummaries')
    expect(normaliseSlackChannelName('complaintcallsummaries')).toBe('complaintcallsummaries')
    expect(normaliseSlackChannelName('  ##CallSummaries  ')).toBe('callsummaries')
  })

  it('returns an empty string for a name with no alphanumerics', () => {
    expect(normaliseSlackChannelName('#')).toBe('')
    expect(normaliseSlackChannelName('   ')).toBe('')
  })
})

describe('slackChannelNameMatches', () => {
  it('matches across formatting variants', () => {
    expect(slackChannelNameMatches('#complaint-call-summaries', 'Complaint Call Summaries')).toBe(true)
    expect(slackChannelNameMatches('complaintcallsummaries', '#complaintcallsummaries')).toBe(true)
  })

  it('does not match different channels', () => {
    expect(slackChannelNameMatches('callsummaries', 'complaintcallsummaries')).toBe(false)
  })

  it('never matches on an empty normalised name', () => {
    expect(slackChannelNameMatches('#', '#')).toBe(false)
  })
})

describe('getTopicDefaultChannelName', () => {
  it('returns the canonical channel name for topics that have one', () => {
    expect(getTopicDefaultChannelName('complaint_call_summary')).toBe('complaintcallsummaries')
    expect(getTopicDefaultChannelName('call_summary')).toBe('callsummaries')
  })

  it('returns null for topics without a canonical channel', () => {
    expect(getTopicDefaultChannelName('general_alert')).toBeNull()
    expect(getTopicDefaultChannelName('finance_dd_defaulters')).toBeNull()
  })
})

describe('isSlackTopic', () => {
  it('recognises registered topics only', () => {
    expect(isSlackTopic('complaint_call_summary')).toBe(true)
    expect(isSlackTopic('not_a_topic')).toBe(false)
  })
})
