// Slack Events API webhook. CLAUDE.md §7.1, §12.
// Verify v0 signature -> handle url_verification handshake -> filter by
// channel scope (bot membership, or the SLACK_WATCHED_CHANNELS allowlist when
// set) -> upsert ProviderEvent (idempotent on event_id) -> enqueue Inngest ->
// 200 fast. All real work happens in the Inngest job.
//
// GET is a configuration self-check (booleans only, no secrets): open the
// webhook URL in a browser to see whether the deployed app actually has the
// signing secret + bot token loaded — the first thing to check when Slack's
// "Retry" fails its URL verification.

import { logger } from '@studymind/core/logger'
import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { getWatchedChannels, isWatchedChannel } from '@studymind/integration-slack/config'
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  verifyAndParse,
} from '@studymind/integration-slack/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'slack', surface: 'webhook' })
export const GET = withSentry(handleGet, { provider: 'slack', surface: 'webhook' })

async function handleGet(): Promise<Response> {
  const watched = getWatchedChannels()
  return Response.json({
    ok: true,
    endpoint: 'slack-events',
    signingSecretConfigured: Boolean(process.env['SLACK_SIGNING_SECRET']),
    botTokenConfigured: Boolean(process.env['SLACK_BOT_TOKEN']),
    // Name-only mentions need the AI extractor; if this is false, those messages
    // can only auto-link when they carry an email/phone. (The relink job still
    // retries them for free once a match becomes unambiguous.)
    aiConfigured: Boolean(
      process.env['GEMINI_API_KEY'] ??
      process.env['GOOGLE_API_KEY'] ??
      process.env['OPENAI_API_KEY'],
    ),
    channelMode:
      watched.length > 0
        ? `allowlist (${watched.length} channels)`
        : 'every channel the bot is invited to',
  })
}

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)
  const timestamp = req.headers.get(TIMESTAMP_HEADER)

  const result = verifyAndParse(raw, signature, timestamp)
  if (!result.ok) {
    // CLAUDE.md §12: never log the raw body of an unverified event. The reason
    // is safe (an enum) and turns a mute 400 into a diagnosable one —
    // `missing_secret` = env not loaded; `signature_mismatch` = wrong secret.
    logger.warn({ reason: result.reason }, 'slack.webhook_rejected')
    return Response.json({ error: result.reason }, { status: 400 })
  }

  const payload = result.payload

  // URL verification handshake (one-off when the endpoint is registered).
  if (payload.type === 'url_verification') {
    return Response.json({ challenge: payload.challenge })
  }

  // Real event. Filter by watched-channel allowlist (§12).
  const inner = payload.event
  if (!isWatchedChannel(inner.channel)) {
    return Response.json({ ok: true, ignored: 'channel_not_watched' })
  }

  const upsert = await upsertProviderEvent(db, {
    provider: 'slack',
    eventId: payload.event_id,
    type: `${inner.type}.channels`,
    raw: payload as unknown,
    receivedAt: new Date(payload.event_time * 1000),
  })

  await inngest.send({
    name: 'slack/event.received',
    data: {
      eventId: payload.event_id,
      providerEventRowId: upsert.id,
      type: `${inner.type}.channels`,
    },
  })

  return Response.json({ ok: true })
}
