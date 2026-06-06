// Trengo webhook signature verification.
// CLAUDE.md §7.1, §11. Trengo sends `Trengo-Signature: <timestamp>;<hash>`,
// where <hash> is the lowercase hex HMAC-SHA256 of `<timestamp>.<rawBody>`
// keyed with TRENGO_WEBHOOK_SECRET. The timestamp is part of the signed
// material, so we split it out and feed it back into the HMAC. Constant-time
// compare, reject 400 on mismatch. Never log the raw body of an unverified
// event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { TrengoWebhookEnvelope } from './types'

// `Headers.get` matches header names case-insensitively, so this lowercase
// key resolves Trengo's canonical `Trengo-Signature` header.
export const SIGNATURE_HEADER = 'trengo-signature' as const

export interface VerifyOptions {
  webhookSecret?: string
}

export type VerifyResult =
  | { ok: true; envelope: TrengoWebhookEnvelope }
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

export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  const secret = opts.webhookSecret ?? process.env['TRENGO_WEBHOOK_SECRET']
  if (!secret) return { ok: false, reason: 'missing_secret' }

  // Trengo's header value is `<timestamp>;<hash>`. The timestamp is part of
  // the signed material, so split on the first ';' and feed it back in. A
  // value without a non-empty timestamp AND hash can never be valid.
  const sepIndex = signature.indexOf(';')
  if (sepIndex <= 0 || sepIndex >= signature.length - 1) {
    return { ok: false, reason: 'signature_mismatch' }
  }
  const timestamp = signature.slice(0, sepIndex)
  const providedHash = signature.slice(sepIndex + 1)

  const computed = createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex')
  if (!safeHexEqual(computed, providedHash.toLowerCase())) {
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

function isEnvelope(value: unknown): value is TrengoWebhookEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v['id'] === 'string' &&
    typeof v['event'] === 'string' &&
    typeof v['occurred_at'] === 'string' &&
    typeof v['data'] === 'object' &&
    v['data'] !== null
  )
}
