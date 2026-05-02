// Trengo webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { TrengoEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'x-trengo-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: TrengoEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
