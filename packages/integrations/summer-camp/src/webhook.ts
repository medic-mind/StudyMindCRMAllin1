// Summer Camp webhook signature verification. CLAUDE.md §7.1, §8, §44.2.
//
// The camp app signs with a plain hex HMAC-SHA256 of the RAW body, in the
// `x-summer-camp-signature` header (see camp `lib/crm-sync.ts`). We recompute
// over the raw bytes BEFORE JSON-parsing and constant-time compare. Reject on
// mismatch; never log the raw body of an unverified event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { BookingEventEnvelope } from './types'

export const SIGNATURE_HEADER = 'x-summer-camp-signature' as const

export type VerifyResult =
  | { ok: true; envelope: BookingEventEnvelope }
  | {
      ok: false
      reason: 'missing_signature' | 'missing_secret' | 'signature_mismatch' | 'invalid_body'
    }

export interface VerifyOptions {
  webhookSecret?: string | null
}

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify the signature over the RAW body and parse the envelope. Returns
 * `{ ok: false, reason }` for every failure mode rather than throwing, so the
 * route handler maps cleanly to a 400.
 */
export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const secret = opts.webhookSecret
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  if (!safeHexEqual(expected, signature.trim().toLowerCase())) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }

  const result = BookingEventEnvelope.safeParse(json)
  if (!result.success) return { ok: false, reason: 'invalid_body' }
  return { ok: true, envelope: result.data }
}
