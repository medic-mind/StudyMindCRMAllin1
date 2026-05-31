// Invoicing webhook signature verification. CLAUDE.md §7.1, §8, §44.2.
//
// The platform signs with HMAC-SHA256 over `${t}.${rawBody}` and sends the
// header `X-Webhook-Signature: t=<unix>,v1=<hex>`. We recompute over the RAW
// body BEFORE JSON-parsing and constant-time compare. Reject 400 on mismatch;
// never log the raw body of an unverified event — it may be hostile.

import { createHmac, timingSafeEqual } from 'node:crypto'

import { RawEvent } from './types'
import type { z } from 'zod'

export const SIGNATURE_HEADER = 'x-webhook-signature' as const
export const EVENT_HEADER = 'x-webhook-event' as const
export const ID_HEADER = 'x-webhook-id' as const

/** Default tolerance for the timestamp in the signature header (5 minutes),
 *  matching the Slack replay-protection convention (CLAUDE.md §12). */
export const DEFAULT_TOLERANCE_SECONDS = 300

export interface VerifyOptions {
  webhookSecret?: string | null
  toleranceSeconds?: number
  /** Injectable clock for deterministic tests. */
  nowMs?: number
}

export type WebhookEnvelope = z.infer<typeof RawEvent>

export type VerifyResult =
  | { ok: true; envelope: WebhookEnvelope }
  | {
      ok: false
      reason:
        | 'missing_signature'
        | 'missing_secret'
        | 'malformed_signature'
        | 'timestamp_out_of_tolerance'
        | 'signature_mismatch'
        | 'invalid_body'
    }

function parseSignatureHeader(header: string): { t: string; v1: string } | null {
  const parts: Record<string, string> = {}
  for (const kv of header.split(',')) {
    const idx = kv.indexOf('=')
    if (idx === -1) continue
    const k = kv.slice(0, idx).trim()
    const v = kv.slice(idx + 1).trim()
    if (k) parts[k] = v
  }
  if (!parts['t'] || !parts['v1']) return null
  return { t: parts['t'], v1: parts['v1'] }
}

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

/**
 * Verify a webhook signature over the RAW body and parse the envelope. Returns
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

  const parsedSig = parseSignatureHeader(signature)
  if (!parsedSig) return { ok: false, reason: 'malformed_signature' }

  // Replay protection: reject signatures whose timestamp is outside tolerance.
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  const tNum = Number.parseInt(parsedSig.t, 10)
  if (!Number.isFinite(tNum)) return { ok: false, reason: 'malformed_signature' }
  const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1000)
  if (Math.abs(nowSec - tNum) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const expected = createHmac('sha256', secret).update(`${parsedSig.t}.${rawBody}`).digest('hex')
  if (!safeHexEqual(expected, parsedSig.v1.toLowerCase())) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  let json: unknown
  try {
    json = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }

  const result = RawEvent.safeParse(json)
  if (!result.success) return { ok: false, reason: 'invalid_body' }
  return { ok: true, envelope: result.data }
}
