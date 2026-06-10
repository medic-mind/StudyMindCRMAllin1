// Direct Debit sign-up email templates (ADR 0038 amendment). Pure builders —
// we pin the parts that matter: the durable link is present in both bodies,
// names fall back gracefully, user-supplied text is HTML-escaped, and the
// reminder states the days remaining.

import { describe, expect, it } from 'vitest'

import {
  buildDirectDebitReminderEmail,
  buildDirectDebitSetupEmail,
} from './direct-debit-setup'

const SETUP_URL = 'https://crm.studymind.co.uk/api/gocardless/setup/tok_abc123'

describe('buildDirectDebitSetupEmail', () => {
  it('includes the durable link in text and html, with the plan wording', () => {
    const email = buildDirectDebitSetupEmail({
      firstName: 'Sarah',
      setupUrl: SETUP_URL,
      description: 'Weekly tuition — 2 hours',
      validForDays: 14,
    })
    expect(email.subject).toBe('Set up your Direct Debit with StudyMind')
    expect(email.text).toContain('Hello Sarah,')
    expect(email.text).toContain(SETUP_URL)
    expect(email.text).toContain('Weekly tuition — 2 hours')
    expect(email.text).toContain('valid for 14 days')
    expect(email.html).toContain(SETUP_URL)
    expect(email.html).toContain('Direct Debit Guarantee')
  })

  it('greets neutrally when no first name is known', () => {
    const email = buildDirectDebitSetupEmail({
      setupUrl: SETUP_URL,
      validForDays: 14,
    })
    expect(email.text).toContain('Hello,')
  })

  it('escapes user-supplied description in the html part', () => {
    const email = buildDirectDebitSetupEmail({
      firstName: '<b>x</b>',
      setupUrl: SETUP_URL,
      description: '<script>alert(1)</script>',
      validForDays: 14,
    })
    expect(email.html).not.toContain('<script>')
    expect(email.html).toContain('&lt;script&gt;')
  })
})

describe('buildDirectDebitReminderEmail', () => {
  it('states the days remaining and keeps the same link', () => {
    const email = buildDirectDebitReminderEmail({
      firstName: 'Sarah',
      setupUrl: SETUP_URL,
      description: 'Weekly tuition',
      validForDays: 11,
      daysRemaining: 11,
    })
    expect(email.subject).toContain('reminder')
    expect(email.text).toContain(SETUP_URL)
    expect(email.text).toContain('another 11 days')
  })

  it('never says zero days', () => {
    const email = buildDirectDebitReminderEmail({
      setupUrl: SETUP_URL,
      validForDays: 1,
      daysRemaining: 0,
    })
    expect(email.text).toContain('another 1 day')
  })
})
