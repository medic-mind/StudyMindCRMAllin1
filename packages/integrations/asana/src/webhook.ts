// Asana webhook signature verification. CLAUDE.md §13.
//
// Two phases:
// 1. Handshake. Asana sends an X-Hook-Secret on webhook creation. The route
//    handler stores it on AsanaWebhook.webhookSecret and echoes it back in
//    the response header. Any subsequent payload is HMAC-SHA-256 signed
//    using THAT per-webhook secret in X-Hook-Signature.
// 2. Steady state. Each delivery's signature is `hex(hmac_sha256(secret, raw))`.
//    We compare in constant time.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { AsanaEventBatch } from './types.js'

export const SIGNATURE_HEADER = 'x-hook-signature' as const
export const SECRET_HEADER = 'x-hook-secret' as const

export type VerifyResult =
  | { ok: true; batch: AsanaEventBatch }
  | { ok: false; reason: 'missing_signature' | 'signature_mismatch' | 'invalid_body' }

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  webhookSecret: string,
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const computed = createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex')
  if (!safeHexEqual(computed, signature.toLowerCase())) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }
  if (!isBatch(parsed)) return { ok: false, reason: 'invalid_body' }
  return { ok: true, batch: parsed }
}

function isBatch(value: unknown): value is AsanaEventBatch {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return Array.isArray(v['events'])
}
