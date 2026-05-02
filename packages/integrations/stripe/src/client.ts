// Authenticated Stripe SDK client factory.
// One instance per process is fine; the Stripe SDK handles connection pooling.

import Stripe from 'stripe'

// Pinned API version. Bumping this is a coordinated change — Stripe ships a
// new minor every few months and we want to opt in deliberately.
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2025-02-24.acacia'

let cached: Stripe | null = null

export interface StripeClientOptions {
  apiKey?: string
  apiVersion?: Stripe.LatestApiVersion
}

/**
 * Create (or return the cached) Stripe client.
 * Reads `STRIPE_SECRET_KEY` from env unless `apiKey` is supplied.
 */
export function createClient(opts: StripeClientOptions = {}): Stripe {
  if (cached && !opts.apiKey) return cached
  const apiKey = opts.apiKey ?? process.env['STRIPE_SECRET_KEY']
  if (!apiKey) {
    throw new Error('STRIPE_SECRET_KEY is not set')
  }
  const client = new Stripe(apiKey, {
    apiVersion: opts.apiVersion ?? STRIPE_API_VERSION,
    typescript: true,
    appInfo: {
      name: 'StudyMind CRM',
      version: '0.1.0',
    },
  })
  if (!opts.apiKey) cached = client
  return client
}

/**
 * Reset the cached client. Tests only.
 */
export function __resetClientForTests(): void {
  cached = null
}
