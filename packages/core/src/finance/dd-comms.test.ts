// Pure token rendering for Direct Debit recovery templates (ADR 0038, Phase 3).

import { describe, expect, it } from 'vitest'

import { renderRecoveryTemplate } from './dd-comms'

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
