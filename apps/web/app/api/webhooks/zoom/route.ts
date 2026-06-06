// Zoom webhook (ADR 0035). CLAUDE.md §7.1 — verify signature, handle the
// one-off URL-validation handshake, persist the raw event (idempotent), enqueue
// async processing, return 200 fast. The Inngest worker emails the recording.
//
// Subscribed event: `recording.completed`. Without ZOOM_WEBHOOK_SECRET_TOKEN the
// endpoint fails closed (every request is rejected).

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { client as zoomClient } from '@studymind/integration-zoom'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'zoom', surface: 'webhook' })

interface ZoomEvent {
  event?: string
  event_ts?: number
  payload?: {
    plainToken?: string
    object?: { id?: number | string; uuid?: string; topic?: string }
  }
}

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get('x-zm-signature')
  const timestamp = req.headers.get('x-zm-request-timestamp')

  if (!zoomClient.readWebhookSecret()) {
    return new Response('zoom webhook not configured', { status: 503 })
  }
  if (!zoomClient.verifyWebhookSignature({ rawBody: raw, signature, timestamp })) {
    // §7.1: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
  }

  let event: ZoomEvent
  try {
    event = JSON.parse(raw) as ZoomEvent
  } catch {
    return new Response('bad json', { status: 400 })
  }

  // One-off endpoint URL validation handshake.
  if (event.event === 'endpoint.url_validation' && event.payload?.plainToken) {
    const res = zoomClient.buildUrlValidationResponse(event.payload.plainToken)
    if (!res) return new Response('zoom webhook not configured', { status: 503 })
    return Response.json(res)
  }

  if (event.event === 'recording.completed') {
    const obj = event.payload?.object
    const meetingId = obj?.id != null ? String(obj.id) : null
    const occurrence = obj?.uuid ?? String(event.event_ts ?? Date.now())
    if (meetingId) {
      const upsert = await upsertProviderEvent(db, {
        provider: 'zoom',
        eventId: occurrence,
        type: 'recording.completed',
        raw: event as unknown,
        receivedAt: new Date(),
      })
      await inngest.send({
        name: 'webinar/recording.completed',
        data: { meetingId, providerEventRowId: upsert.id },
      })
    }
  }

  return Response.json({ ok: true })
}
