// Stripe webhook signature verification.
// CLAUDE.md §7.1, §8: verify before any DB write. Reject 400 on mismatch.
// Never log the raw body of an unverified event — it may be hostile.

import Stripe from 'stripe'

import { STRIPE_API_VERSION } from './client'

export const SIGNATURE_HEADER = 'stripe-signature' as const

export interface VerifiedEvent {
  ok: true
  event: Stripe.Event
}

export interface RejectedEvent {
  ok: false
  reason: 'missing_signature' | 'missing_secret' | 'signature_mismatch'
}

export type VerifyResult = VerifiedEvent | RejectedEvent

export interface VerifyOptions {
  webhookSecret?: string
  // Stripe's default tolerance is 300s. Pin it explicitly so a clock-skew bug
  // does not silently widen our acceptance window.
  toleranceSeconds?: number
}

/**
 * Verify a Stripe webhook payload's signature.
 *
 * Returns `{ ok: false, reason }` on every failure mode rather than throwing,
 * so the route handler can map cleanly to a 400 without try/catch noise.
 *
 * Never returns the parsed body when verification fails. Per CLAUDE.md §8 the
 * route must not log the raw body in that case.
 */
export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const secret = opts.webhookSecret ?? process.env['STRIPE_WEBHOOK_SECRET']
  if (!secret) return { ok: false, reason: 'missing_secret' }

  // constructEvent does not actually call the Stripe API; the api key here is
  // unused. We avoid calling createClient() so this works without
  // STRIPE_SECRET_KEY in environments that only receive webhooks.
  const stripe = new Stripe('sk_unused_for_construct_event', {
    apiVersion: STRIPE_API_VERSION,
    typescript: true,
  })

  try {
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      secret,
      opts.toleranceSeconds ?? 300,
    )
    return { ok: true, event }
  } catch {
    // Intentionally swallow the underlying error message: it can include the
    // computed signature, which we should not surface to the route handler.
    return { ok: false, reason: 'signature_mismatch' }
  }
}
