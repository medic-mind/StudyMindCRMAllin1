// Authenticated SDK client factory for Stripe.

export interface StripeClient {
  readonly baseUrl: string
}

export function createClient(): StripeClient {
  throw new Error('not implemented')
}
