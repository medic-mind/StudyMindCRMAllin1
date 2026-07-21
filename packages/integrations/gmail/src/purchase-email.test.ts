import { describe, expect, it } from 'vitest'

import { isPurchaseAlertSender, purchaseAlertSenders } from './purchase-email'

describe('purchaseAlertSenders', () => {
  it('defaults to the Stripe senders when unset', () => {
    expect(purchaseAlertSenders({})).toEqual(['receipts@stripe.com', 'notifications@stripe.com'])
  })

  it('reads a comma list, lower-cased and trimmed', () => {
    expect(
      purchaseAlertSenders({ PURCHASE_ALERT_SENDERS: ' Orders@Shop.com , pay@x.io ' }),
    ).toEqual(['orders@shop.com', 'pay@x.io'])
  })
})

describe('isPurchaseAlertSender', () => {
  const senders = ['receipts@stripe.com', 'notifications@stripe.com']

  it('matches a configured sender (case-insensitive)', () => {
    expect(isPurchaseAlertSender(['Receipts@Stripe.com'], senders)).toBe(true)
    expect(isPurchaseAlertSender(['notifications@stripe.com'], senders)).toBe(true)
  })

  it('matches a Stripe sub-addressed receipts+acct_…@ against its base', () => {
    expect(isPurchaseAlertSender(['receipts+acct_1C0q6QCc7hVuj9kL@stripe.com'], senders)).toBe(true)
  })

  it('does not match an unrelated sender', () => {
    expect(isPurchaseAlertSender(['someone@gmail.com'], senders)).toBe(false)
    expect(isPurchaseAlertSender([], senders)).toBe(false)
  })

  it('honours a custom sender list', () => {
    expect(isPurchaseAlertSender(['orders@shop.com'], ['orders@shop.com'])).toBe(true)
    expect(isPurchaseAlertSender(['receipts@stripe.com'], ['orders@shop.com'])).toBe(false)
  })
})
