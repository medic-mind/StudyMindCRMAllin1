// Aircall webhook signature verification.
// CLAUDE.md §7.1, §10: verify HMAC-SHA-256 of the raw body using
// AIRCALL_WEBHOOK_TOKEN, constant-time compare, reject 400 on mismatch.
// Never log the raw body of an unverified event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { AircallWebhookEnvelope } from './types'

// Aircall signs with `Aircall-Signature`; Next normalises header names to
// lower case, so both spellings work, but the canonical form we read is the
// lower-case one.
export const SIGNATURE_HEADER = 'aircall-signature' as const

export interface VerifyOptions {
  webhookToken?: string
}

export type VerifyResult =
  | { ok: true; envelope: AircallWebhookEnvelope }
  | {
      ok: false
      reason:
        | 'missing_signature'
        | 'missing_secret'
        | 'signature_mismatch'
        | 'invalid_body'
    }

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify an Aircall webhook payload's signature and parse the body.
 *
 * Returns `{ ok: false, reason }` on every failure mode rather than throwing,
 * so the route handler can map cleanly to a 400 without try/catch noise.
 *
 * Per CLAUDE.md §10, the route MUST NOT log the raw body when this returns
 * `ok: false`.
 */
export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const token = opts.webhookToken ?? process.env['AIRCALL_WEBHOOK_TOKEN']
  if (!token) return { ok: false, reason: 'missing_secret' }

  const computed = createHmac('sha256', token).update(rawBody, 'utf8').digest('hex')
  if (!safeHexEqual(computed, signature.toLowerCase())) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }

  if (!isEnvelope(parsed)) {
    return { ok: false, reason: 'invalid_body' }
  }

  return { ok: true, envelope: parsed }
}

function isEnvelope(value: unknown): value is AircallWebhookEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['event'] === 'string' &&
    typeof v['timestamp'] === 'string' &&
    typeof v['data'] === 'object' &&
    v['data'] !== null
  )
}
