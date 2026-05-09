// Trengo webhook handler. CLAUDE.md §7.1, §11.
// Verify signature -> upsert ProviderEvent (idempotent on envelope.id) ->
// enqueue Inngest -> 200 fast. All real work happens in the Inngest job.

import { upsertProviderEvent } from '@studymind/core/provider-events'
import {
  SIGNATURE_HEADER,
  verifyAndParse,
} from '@studymind/integration-trengo/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  const result = verifyAndParse(raw, signature)
  if (!result.ok) {
    // CLAUDE.md §11: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
  }

  const envelope = result.envelope

  const upsert = await upsertProviderEvent(db, {
    provider: 'trengo',
    eventId: envelope.id,
    type: envelope.event,
    raw: envelope as unknown,
    receivedAt: new Date(envelope.occurred_at),
  })

  await inngest.send({
    name: 'trengo/event.received',
    data: {
      eventId: envelope.id,
      providerEventRowId: upsert.id,
      type: envelope.event,
    },
  })

  return Response.json({ ok: true })
}
