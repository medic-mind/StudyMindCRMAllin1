// Summer Camp booking webhook handler. CLAUDE.md §7.1, §8, §44.2.
// Verify HMAC on the RAW body -> upsert ProviderEvent (idempotent) -> enqueue
// Inngest -> 200 fast. All real work happens in the Inngest job. The webhook
// secret is the shared SUMMER_CAMP_WEBHOOK_SECRET (env). Mirrors the Stripe /
// invoicing handler shape.

import { withSentry } from '@studymind/core/observability/sentry'
import { withSpan } from '@studymind/core/observability/trace'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { SUMMER_CAMP_PROVIDER } from '@studymind/integration-summer-camp/types'
import { SIGNATURE_HEADER, verifyAndParse } from '@studymind/integration-summer-camp/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: SUMMER_CAMP_PROVIDER, surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  return withSpan('webhook.summer-camp', async () => {
    const raw = await req.text()
    const signature = req.headers.get(SIGNATURE_HEADER)

    if (!signature) {
      return new Response('missing signature', { status: 400 })
    }

    const webhookSecret = process.env['SUMMER_CAMP_WEBHOOK_SECRET']
    if (!webhookSecret) {
      // Configured-but-missing: cannot verify, so reject cleanly rather than
      // accept an unverified event. 503 → the camp app retries later.
      return new Response('webhook secret not configured', { status: 503 })
    }

    const result = verifyAndParse(raw, signature, { webhookSecret })
    if (!result.ok) {
      // CLAUDE.md §8: never log the raw body of an unverified event.
      return new Response('invalid signature', { status: 400 })
    }

    const { envelope } = result

    return withSpan(
      'webhook.summer-camp.persist',
      async () => {
        const upsert = await upsertProviderEvent(db, {
          provider: SUMMER_CAMP_PROVIDER,
          eventId: envelope.id,
          type: envelope.type,
          raw: envelope as unknown,
          receivedAt: envelope.occurred_at ? new Date(envelope.occurred_at) : new Date(),
        })

        // Only enqueue once per event id — duplicate deliveries are no-ops.
        if (upsert.created) {
          await inngest.send({
            name: 'summer-camp/event.received',
            data: {
              eventId: envelope.id,
              providerEventRowId: upsert.id,
              type: envelope.type,
            },
          })
        }

        return Response.json({ ok: true })
      },
      { provider: SUMMER_CAMP_PROVIDER, endpoint: 'webhook', entity_id: envelope.id },
    )
  })
}
