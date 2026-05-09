// Stripe webhook handler. CLAUDE.md §7.1, §8.
// Verify signature -> upsert ProviderEvent (idempotent) -> enqueue Inngest -> 200.
// All real work happens in the Inngest job. Latency budget: 500 ms p90.

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { SIGNATURE_HEADER, verifyAndParse } from '@studymind/integration-stripe/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'stripe', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  // Raw body bytes — required for signature verification.
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  const result = verifyAndParse(raw, signature)
  if (!result.ok) {
    // CLAUDE.md §8: never log the raw body of an unverified event.
    return new Response('invalid signature', { status: 400 })
  }

  const { event } = result

  // Persist raw event for audit and replay. Idempotent on (provider, eventId).
  const upsert = await upsertProviderEvent(db, {
    provider: 'stripe',
    eventId: event.id,
    type: event.type,
    raw: event as unknown,
    receivedAt: new Date(event.created * 1000),
  })

  // Always enqueue: the Inngest job is itself idempotent so a duplicate
  // delivery from Stripe is safe. Skipping on dedupe would also block a
  // legitimate retry from Stripe after a previous failed run.
  await inngest.send({
    name: 'stripe/event.received',
    data: { eventId: event.id, providerEventRowId: upsert.id, type: event.type },
  })

  return Response.json({ ok: true })
}
