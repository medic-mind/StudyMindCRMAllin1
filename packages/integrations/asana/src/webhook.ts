// Asana webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { AsanaEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'x-hook-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: AsanaEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
