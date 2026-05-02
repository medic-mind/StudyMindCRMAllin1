// GoCardless webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { GocardlessEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'webhook-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: GocardlessEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
