// booking webhook handler. See CLAUDE.md Section 7.1.
// Verify signature, persist raw event, enqueue Inngest job, return 2xx fast.

import { withSentry } from '@studymind/core/observability/sentry'
import { SIGNATURE_HEADER, verifyAndParse } from '@studymind/integration-booking/webhook'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'booking', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const signature = req.headers.get(SIGNATURE_HEADER)

  let result
  try {
    result = verifyAndParse(raw, signature)
  } catch {
    // Skeleton — verifyAndParse throws 'not implemented' until we ship the integration.
    return new Response('not implemented', { status: 501 })
  }

  if (!result.ok || !result.event) {
    return new Response('invalid signature', { status: 400 })
  }

  // TODO: persist to ProviderEvent (idempotent on (provider, eventId)) then enqueue Inngest.
  return Response.json({ ok: true })
}
