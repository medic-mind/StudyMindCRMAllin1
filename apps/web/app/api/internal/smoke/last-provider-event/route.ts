// Post-deploy smoke: verify a synthetic Stripe webhook event landed.
// CLAUDE.md §24.1.
//
// Admin-only. Used by the post-deploy smoke workflow to confirm that the
// Inngest pipeline persisted a freshly-signed test event to ProviderEvent.
// Returns `{ exists, receivedAt }` for the given (provider, eventId).

import { legacyAuth as auth } from '@/lib/auth/server'

import { writeAuditLogEntry } from '@studymind/audit'
import { withSentry } from '@studymind/core/observability/sentry'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const GET = withSentry(handleGet, { surface: 'smoke_provider_event' })

async function handleGet(req: Request): Promise<Response> {
  // Two acceptable auth modes:
  //   1. Admin session (interactive ops use).
  //   2. Bearer token equal to SMOKE_ADMIN_TOKEN (CI post-deploy smoke).
  // Both paths are audited.
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null
  const smokeToken = process.env['SMOKE_ADMIN_TOKEN'] ?? null

  let userId: string | null = null
  if (bearer && smokeToken && bearer === smokeToken) {
    userId = 'system:smoke'
  } else {
    const session = await auth()
    if (!session.userId) return new Response('unauthorised', { status: 401 })
    // Admin-tier smoke endpoint (ADR 0014). Legacy admin / super_admin JWTs
    // remain honoured until session rollover.
    const role = (session.sessionClaims?.['role'] as string | undefined) ?? 'virtual_assistant'
    if (
      role !== 'ceo' &&
      role !== 'senior_manager' &&
      role !== 'admin' &&
      role !== 'super_admin'
    ) {
      return new Response('forbidden', { status: 403 })
    }
    userId = session.userId
  }

  const url = new URL(req.url)
  const eventId = url.searchParams.get('eventId')
  const provider = url.searchParams.get('provider') ?? 'stripe'
  if (!eventId) {
    return Response.json({ error: 'eventId is required' }, { status: 400 })
  }
  const requestId = req.headers.get('x-request-id') ?? `smoke-${Date.now()}-${userId}`

  const row = await db.providerEvent.findUnique({
    where: { provider_eventId: { provider, eventId } },
    select: { receivedAt: true, processedAt: true },
  })

  await writeAuditLogEntry(db, {
    actorId: userId,
    action: 'system.job_completed',
    target: { type: 'ProviderEvent', id: eventId },
    requestId,
    after: { provider, eventId, exists: row !== null },
  })

  return Response.json(
    {
      exists: row !== null,
      provider,
      eventId,
      receivedAt: row?.receivedAt ?? null,
      processedAt: row?.processedAt ?? null,
    },
    { headers: { 'cache-control': 'no-store', 'x-request-id': requestId } },
  )
}
