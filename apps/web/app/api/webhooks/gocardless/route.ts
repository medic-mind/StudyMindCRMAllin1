// GoCardless webhook handler. CLAUDE.md §7.1, §9.
// Verify signature -> for each event in events[], upsert ProviderEvent
// (idempotent) -> enqueue Inngest -> 200. All real work happens in the Inngest
// job. Latency budget: 500 ms p90.
//
// A single GoCardless webhook request can carry multiple events. Each one
// gets its own ProviderEvent row and its own `gocardless/event.received`
// enqueue, dedupe-keyed on (provider='gocardless', eventId=event.id).

import { upsertProviderEvent } from '@studymind/core/provider-events'
import {
  SIGNATURE_HEADER,
  verifyAndParse,
} from '@studymind/integration-gocardless/webhook'
import { gcEventKey } from '@studymind/integration-gocardless/types'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  // Raw body bytes — required for HMAC verification.
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  const result = verifyAndParse(raw, signature)
  if (!result.ok) {
    // CLAUDE.md §9: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
  }

  const { payload } = result

  // Process each event independently. The order of `events[]` is the order
  // GoCardless emitted them; we preserve it across enqueues.
  for (const event of payload.events) {
    const upsert = await upsertProviderEvent(db, {
      provider: 'gocardless',
      eventId: event.id,
      type: gcEventKey(event),
      raw: event as unknown,
      receivedAt: new Date(event.created_at),
    })

    // Always enqueue: the Inngest job is itself idempotent, and a duplicate
    // delivery from GoCardless after a previous failure must still re-trigger.
    await inngest.send({
      name: 'gocardless/event.received',
      data: {
        eventId: event.id,
        providerEventRowId: upsert.id,
        type: gcEventKey(event),
      },
    })
  }

  return Response.json({ ok: true })
}
