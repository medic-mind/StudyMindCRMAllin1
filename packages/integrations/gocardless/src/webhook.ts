// GoCardless webhook signature verification.
// CLAUDE.md §7.1, §9: HMAC-SHA-256 of the raw body, constant-time compare,
// reject 400 on mismatch. A single request can carry multiple events in
// `events[]` — the verified payload reflects this.
//
// Never log the raw body of an unverified event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { GcEvent, GcWebhookPayload } from './types'

export const SIGNATURE_HEADER = 'webhook-signature' as const

export interface VerifiedPayload {
  ok: true
  payload: GcWebhookPayload
}

export interface RejectedPayload {
  ok: false
  reason: 'missing_signature' | 'missing_secret' | 'signature_mismatch' | 'invalid_body'
}

export type VerifyResult = VerifiedPayload | RejectedPayload

export interface VerifyOptions {
  webhookSecret?: string
}

/**
 * Constant-time hex compare. Both inputs are expected to be lowercase hex
 * digests of equal length. Mismatched lengths are a guaranteed mismatch.
 */
function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  // Decode both as Buffers for timingSafeEqual; lengths match by precondition.
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify a GoCardless webhook payload's signature.
 *
 * Returns `{ ok: false, reason }` on every failure mode rather than throwing,
 * so the route handler can map cleanly to a 400 without try/catch noise.
 *
 * Never returns the parsed body when verification fails. Per CLAUDE.md §9 the
 * route must not log the raw body in that case.
 */
export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const secret = opts.webhookSecret ?? process.env['GOCARDLESS_WEBHOOK_SECRET']
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  if (!safeHexEqual(computed, signature.toLowerCase())) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  // Only parse JSON AFTER the signature passes — verifying first keeps us off
  // the JSON-parse path for hostile payloads.
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }

  if (!isWebhookPayload(parsed)) {
    return { ok: false, reason: 'invalid_body' }
  }

  return { ok: true, payload: parsed }
}

function isWebhookPayload(value: unknown): value is GcWebhookPayload {
  if (typeof value !== 'object' || value === null) return false
  const events = (value as { events?: unknown }).events
  if (!Array.isArray(events)) return false
  return events.every(isEvent)
}

function isEvent(value: unknown): value is GcEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    typeof v['action'] === 'string' &&
    typeof v['resource_type'] === 'string' &&
    typeof v['links'] === 'object' &&
    v['links'] !== null
  )
}
