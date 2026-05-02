// Gmail webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { GmailEventEnvelope } from './types.js'

export const SIGNATURE_HEADER = 'x-goog-channel-token' as const

export interface VerifyResult {
  ok: boolean
  event?: GmailEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
