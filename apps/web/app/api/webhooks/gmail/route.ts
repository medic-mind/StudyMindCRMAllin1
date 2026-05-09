// Gmail Pub/Sub push handler. CLAUDE.md §7.1, §14.
//
// Verify the OIDC JWT in the Authorization header against Google's public
// keys, decode the inner notification ({ emailAddress, historyId }), upsert
// ProviderEvent, enqueue gmail/history.changed, return 200 fast.

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { AUTH_HEADER, verifyAndParse } from '@studymind/integration-gmail/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'gmail', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  const raw = await req.text()
  const auth = req.headers.get(AUTH_HEADER)

  const audience = process.env['GMAIL_PUBSUB_AUDIENCE']
  if (!audience) {
    // Fail closed if config is missing — better than silently accepting.
    return new Response('not configured', { status: 500 })
  }

  const expectedSa = process.env['GMAIL_PUBSUB_SERVICE_ACCOUNT'] ?? undefined

  const result = await verifyAndParse(raw, auth, {
    audience,
    ...(expectedSa ? { expectedServiceAccountEmail: expectedSa } : {}),
  })
  if (!result.ok) {
    return new Response('invalid token', { status: 401 })
  }

  const { emailAddress, historyId } = result.notification
  // historyId alone is not unique across mailboxes — combine with the address.
  const eventId = `gmail:${emailAddress}:${historyId}`

  const upsert = await upsertProviderEvent(db, {
    provider: 'gmail',
    eventId,
    type: 'history.changed',
    raw: result.notification as unknown,
  })

  await inngest.send({
    name: 'gmail/history.changed',
    data: {
      eventId,
      providerEventRowId: upsert.id,
      emailAddress,
      historyId,
    },
  })

  return Response.json({ ok: true })
}
