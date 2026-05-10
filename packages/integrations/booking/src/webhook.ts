// Booking site webhook signature verification + payload normalisation.
// See CLAUDE.md Section 7.1.

import type { BookingEventEnvelope } from './types'

export const SIGNATURE_HEADER = 'x-booking-signature' as const

export interface VerifyResult {
  ok: boolean
  event?: BookingEventEnvelope
}

export function verifyAndParse(_rawBody: string, _signature: string | null): VerifyResult {
  throw new Error('not implemented')
}
