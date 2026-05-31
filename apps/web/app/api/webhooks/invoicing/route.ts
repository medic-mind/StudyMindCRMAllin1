// B2B Invoices Platform webhook handler. CLAUDE.md §7.1, §8, §44.2.
// Verify HMAC on the RAW body -> upsert ProviderEvent (idempotent) -> enqueue
// Inngest -> 200 fast. All real work happens in the Inngest job. The webhook
// secret is loaded from encrypted config (Settings → Invoicing), falling back
// to INVOICING_WEBHOOK_SECRET. Mirrors the Stripe/Trengo handler shape.

import { withSentry } from '@studymind/core/observability/sentry'
import { withSpan } from '@studymind/core/observability/trace'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { loadInvoicingConfig } from '@studymind/integration-invoicing/config'
import { SIGNATURE_HEADER, verifyAndParse } from '@studymind/integration-invoicing/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'invoicing', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  return withSpan('webhook.invoicing', async () => {
    const raw = await req.text()
    const signature = req.headers.get(SIGNATURE_HEADER)

    // Cheapest rejection first: no signature header → 400, no need to touch the
    // (encrypted) config at all.
    if (!signature) {
      return new Response('missing signature', { status: 400 })
    }

    // Loading the config decrypts the stored webhook secret. If the
    // field-encryption backend is misconfigured (e.g. AWS_KMS_KEY_ID set to a
    // placeholder with no real AWS account), that throws — but a webhook
    // handler must never 500 on a config problem (it makes the sender retry
    // forever and shows up as a server error on their side). Return 503 so the
    // platform retries later, once the secret is configured correctly.
    let webhookSecret: string | null
    try {
      const cfg = await loadInvoicingConfig()
      webhookSecret = cfg.webhookSecret
    } catch {
      return new Response('webhook secret unavailable', { status: 503 })
    }

    if (!webhookSecret) {
      // Configured-but-empty: we cannot verify, so reject cleanly rather than
      // accept an unverified event.
      return new Response('webhook secret not configured', { status: 503 })
    }

    const result = verifyAndParse(raw, signature, { webhookSecret })
    if (!result.ok) {
      // CLAUDE.md §8: never log the raw body of an unverified event.
      return new Response('invalid signature', { status: 400 })
    }

    const { envelope } = result

    return withSpan(
      'webhook.invoicing.persist',
      async () => {
        const upsert = await upsertProviderEvent(db, {
          provider: 'invoicing',
          eventId: envelope.id,
          type: envelope.type,
          raw: envelope as unknown,
          receivedAt: envelope.created_at ? new Date(envelope.created_at) : new Date(),
        })

        // Only enqueue once per event id — a duplicate webhook delivery is a
        // no-op (the Inngest job is idempotent too, but this saves the work).
        if (upsert.created) {
          await inngest.send({
            name: 'invoicing/event.received',
            data: {
              eventId: envelope.id,
              providerEventRowId: upsert.id,
              type: envelope.type,
            },
          })
        }

        return Response.json({ ok: true })
      },
      { provider: 'invoicing', endpoint: 'webhook', entity_id: envelope.id },
    )
  })
}
