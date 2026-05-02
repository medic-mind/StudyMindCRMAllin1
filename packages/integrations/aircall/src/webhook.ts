// Aircall webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { AircallEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'x-aircall-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: AircallEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
