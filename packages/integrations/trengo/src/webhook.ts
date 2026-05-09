// Trengo webhook signature verification.
// CLAUDE.md §7.1, §11: verify HMAC-SHA-256 of the raw body using
// TRENGO_WEBHOOK_SECRET, constant-time compare, reject 400 on mismatch.
// Never log the raw body of an unverified event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { TrengoWebhookEnvelope } from './types'

export const SIGNATURE_HEADER = 'x-trengo-signature' as const

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

  const computed = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
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
