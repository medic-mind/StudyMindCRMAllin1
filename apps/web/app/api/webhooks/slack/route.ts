// Slack Events API webhook. CLAUDE.md §7.1, §12.
// Verify v0 signature -> handle url_verification handshake -> filter by
// SLACK_WATCHED_CHANNELS -> upsert ProviderEvent (idempotent on event_id) ->
// enqueue Inngest -> 200 fast. All real work happens in the Inngest job.

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { isWatchedChannel } from '@studymind/integration-slack/config'
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

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)
  const timestamp = req.headers.get(TIMESTAMP_HEADER)

  const result = verifyAndParse(raw, signature, timestamp)
  if (!result.ok) {
    // CLAUDE.md §12: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
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
