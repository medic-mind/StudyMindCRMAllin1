// Aircall webhook handler. CLAUDE.md §7.1, §10.
// Verify signature -> upsert ProviderEvent (idempotent on synthetic event id)
// -> enqueue Inngest -> 200 fast. All real work happens in the Inngest job.
//
// Aircall does not send a unique delivery id; we derive a synthetic id from
// (event, data.id|call_id, timestamp) so a true redelivery dedupes cleanly.

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import {
  aircallEventId,
  type AircallWebhookEnvelope,
} from '@studymind/integration-aircall/types'
import {
  SIGNATURE_HEADER,
  verifyAndParse,
} from '@studymind/integration-aircall/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'aircall', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  const result = verifyAndParse(raw, signature)
  if (!result.ok) {
    // CLAUDE.md §10: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
  }

  const envelope: AircallWebhookEnvelope = result.envelope
  const eventId = aircallEventId(envelope)

  const upsert = await upsertProviderEvent(db, {
    provider: 'aircall',
    eventId,
    type: envelope.event,
    raw: envelope as unknown,
    receivedAt: new Date(envelope.timestamp),
  })

  // Always enqueue: the Inngest job is itself idempotent, and a duplicate
  // delivery from Aircall after a previous failure must still re-trigger.
  await inngest.send({
    name: 'aircall/event.received',
    data: {
      eventId,
      providerEventRowId: upsert.id,
      type: envelope.event,
    },
  })

  return Response.json({ ok: true })
}
