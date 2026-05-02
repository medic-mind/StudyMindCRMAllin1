// Domain-mapped types for Stripe.
// We never let raw provider types leak into the rest of the app.

export interface StripeEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}
