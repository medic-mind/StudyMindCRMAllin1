// Pure token rendering for Direct Debit recovery templates (ADR 0038, Phase 3).

import { describe, expect, it } from 'vitest'

import {
  buildRecoveryVars,
  formatGbpMinor,
  formatUkDate,
  renderRecoveryTemplate,
} from './dd-comms'

describe('renderRecoveryTemplate', () => {
  it('substitutes known tokens, tolerating inner whitespace', () => {
    expect(
      renderRecoveryTemplate('Hi {{first_name}}, you owe {{ amount_due }} on {{plan_name}}.', {
        first_name: 'Sam',
        amount_due: '£800.00',
        plan_name: 'GCSE Maths',
      }),
    ).toBe('Hi Sam, you owe £800.00 on GCSE Maths.')
  })

  it('resolves a missing value to an empty string', () => {
    expect(renderRecoveryTemplate('Hi {{first_name}}!', {})).toBe('Hi !')
  })

  it('leaves an unregistered token untouched (so a typo is visible)', () => {
    expect(renderRecoveryTemplate('Ref {{invoice_no}}', { first_name: 'x' })).toBe(
      'Ref {{invoice_no}}',
    )
  })

  it('replaces every occurrence', () => {
    expect(renderRecoveryTemplate('{{first_name}} {{first_name}}', { first_name: 'Jo' })).toBe(
      'Jo Jo',
    )
  })
})

describe('formatGbpMinor / formatUkDate', () => {
  it('formats pence as GBP', () => {
    expect(formatGbpMinor(100_000)).toBe('£1,000.00')
    expect(formatGbpMinor(45_500)).toBe('£455.00')
    expect(formatGbpMinor(null)).toBe('')
  })
  it('formats a UK long date', () => {
    expect(formatUkDate(new Date('2026-07-05T12:00:00Z'))).toBe('5 July 2026')
    expect(formatUkDate(null)).toBe('')
  })
})

describe('buildRecoveryVars', () => {
  it('splits the name and formats the amount + link', () => {
    const v = buildRecoveryVars({
      fullName: 'Jane Doe',
      outstandingMinor: 80_000,
      setupLinkUrl: 'https://pay.example/x',
    })
    expect(v.first_name).toBe('Jane')
    expect(v.last_name).toBe('Doe')
    expect(v.amount_due).toBe('£800.00')
    expect(v.setup_link).toBe('https://pay.example/x')
    // No CCJ figures unless a ccj estimate is passed — the gentle steps stay blank.
    expect(v.court_fee).toBe('')
    expect(v.total_with_costs).toBe('')
  })

  it('exposes the CCJ figures when an estimate is passed', () => {
    const v = buildRecoveryVars({
      fullName: 'Sam',
      outstandingMinor: 100_000,
      setupLinkUrl: null,
      ccj: {
        lateFeeMinor: 1_200,
        courtFeeMinor: 8_000,
        interestMinor: 8_000,
        dailyInterestMinor: 22,
        totalMinor: 117_200,
      },
      responseDeadline: new Date('2026-08-31T00:00:00Z'),
    })
    expect(v.court_fee).toBe('£80.00')
    expect(v.interest).toBe('£80.00')
    expect(v.daily_interest).toBe('£0.22')
    expect(v.total_with_costs).toBe('£1,172.00')
    expect(v.response_deadline).toBe('31 August 2026')
  })
})
