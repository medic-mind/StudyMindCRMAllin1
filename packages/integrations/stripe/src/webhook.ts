// Stripe webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { StripeEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'stripe-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: StripeEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
