// Domain-mapped types for Stripe.
// Raw Stripe SDK types stay inside this package; the rest of the app reads
// these typed shapes only. CLAUDE.md §6.4 + §8: fail closed on unknown.

import type Stripe from 'stripe'

export interface StripeEventEnvelope {
  id: string
  type: string
  receivedAt: Date
}

// Mirror of the Prisma SubscriptionState enum.
export type SubscriptionState =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unknown'

const KNOWN_SUBSCRIPTION_STATES = new Set<string>([
  'trialing',
  'active',
  'past_due',
  'canceled',
  'unpaid',
  'paused',
  'incomplete',
  'incomplete_expired',
])

/**
 * Map a Stripe subscription status to our domain enum.
 * Unknown values fail closed to `unknown` rather than guess. CLAUDE.md §8.
 */
export function mapSubscriptionState(
  stripeStatus: Stripe.Subscription.Status | string | null | undefined,
): SubscriptionState {
  if (!stripeStatus) return 'unknown'
  return KNOWN_SUBSCRIPTION_STATES.has(stripeStatus)
    ? (stripeStatus as SubscriptionState)
    : 'unknown'
}

// Invoice statuses we care about. Stripe ships: draft, open, paid, uncollectible, void.
export type InvoiceState = 'draft' | 'open' | 'paid' | 'uncollectible' | 'void' | 'unknown'

const KNOWN_INVOICE_STATES = new Set<string>([
  'draft',
  'open',
  'paid',
  'uncollectible',
  'void',
])

export function mapInvoiceState(
  stripeStatus: Stripe.Invoice.Status | string | null | undefined,
): InvoiceState {
  if (!stripeStatus) return 'unknown'
  return KNOWN_INVOICE_STATES.has(stripeStatus) ? (stripeStatus as InvoiceState) : 'unknown'
}
