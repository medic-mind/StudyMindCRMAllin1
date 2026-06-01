// Stripe event handler registry.
// The canonical set lives in jobs.ts (HANDLED_TYPES); this mirrors it for
// documentation and for callers that want to advertise coverage.

export const HANDLED_EVENT_TYPES: readonly string[] = [
  'invoice.payment_failed',
  'customer.subscription.updated',
  'charge.succeeded',
  'charge.refunded',
]
