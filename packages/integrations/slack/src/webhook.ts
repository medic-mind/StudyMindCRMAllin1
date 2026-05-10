// Slack Events API signature verification + payload normalisation.
// CLAUDE.md §12: recompute v0:<timestamp>:<raw_body> HMAC-SHA-256 with the
// signing secret, constant-time compare. Reject if the request timestamp is
// older than 5 minutes (replay protection). Never log raw body.

import { createHmac, timingSafeEqual } from 'node:crypto'

import type { SlackInbound } from './types'

export const SIGNATURE_HEADER = 'x-slack-signature' as const
export const TIMESTAMP_HEADER = 'x-slack-request-timestamp' as const

/** Slack rejects-stale-after: 5 minutes per §12. */
export const REPLAY_WINDOW_SECONDS = 5 * 60

export interface VerifyOptions {
  signingSecret?: string
  /** Override `Date.now()` for tests; UNIX seconds. */
  nowSeconds?: number
}

export type VerifyResult =
  | { ok: true; payload: SlackInbound }
  | {
      ok: false
      reason:
        | 'missing_signature'
        | 'missing_timestamp'
        | 'missing_secret'
        | 'replay_window'
        | 'signature_mismatch'
        | 'invalid_body'
    }

function safeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length || ab.length === 0) return false
  return timingSafeEqual(ab, bb)
}

export function verifyAndParse(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  opts: VerifyOptions = {},
): VerifyResult {
  if (!signature) return { ok: false, reason: 'missing_signature' }
  if (!timestamp) return { ok: false, reason: 'missing_timestamp' }

  const secret = opts.signingSecret ?? process.env['SLACK_SIGNING_SECRET']
  if (!secret) return { ok: false, reason: 'missing_secret' }

  // Replay window — reject anything older than 5 minutes.
  const tsNumber = Number(timestamp)
  if (!Number.isFinite(tsNumber)) return { ok: false, reason: 'missing_timestamp' }
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - tsNumber) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: 'replay_window' }
  }

  const base = `v0:${timestamp}:${rawBody}`
  const computed = `v0=${createHmac('sha256', secret).update(base, 'utf8').digest('hex')}`
  if (!safeHexEqual(computed, signature)) {
    return { ok: false, reason: 'signature_mismatch' }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return { ok: false, reason: 'invalid_body' }
  }
  if (!isSlackInbound(parsed)) {
    return { ok: false, reason: 'invalid_body' }
  }
  return { ok: true, payload: parsed }
}

function isSlackInbound(value: unknown): value is SlackInbound {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if (v['type'] === 'url_verification') {
    return typeof v['challenge'] === 'string'
  }
  if (v['type'] === 'event_callback') {
    return (
      typeof v['event_id'] === 'string' &&
      typeof v['event'] === 'object' &&
      v['event'] !== null
    )
  }
  return false
}
