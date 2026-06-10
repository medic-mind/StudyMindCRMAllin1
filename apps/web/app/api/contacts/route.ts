// Inbound account sync from the Medi Platform (the Medic Mind UCAT portal).
//
// The portal POSTs `user.registered` here whenever someone creates an account
// (server/util/crm.js → crmSync). We onboard them as a Contact — NOT a board
// card or pipeline entry — and dedupe so a later web lead / missed call
// annotates the same record instead of duplicating it (ADR 0037, CLAUDE.md §16).
//
// Thin handler (§7): authenticate → persist ProviderEvent → enqueue → 200. The
// Inngest job `medi/account.received` does the real work, idempotently.

import { withSentry } from '@studymind/core/observability/sentry'

import { db } from '@/lib/db'
import { constantTimeEqual, extractPresentedKey } from '@/lib/leads/api-key'
import { ingestMediAccount } from '@/lib/medi/ingest'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// The portal authenticates with `Authorization: Bearer <CRM_API_KEY>`. We match
// it against a dedicated MEDI_SYNC_TOKEN, falling back to the shared lead
// webhook token so ops can reuse one secret. Fail closed (§8): with no token
// configured we never accept unauthenticated contact creation.
function configuredToken(): string | null {
  return (
    process.env['MEDI_SYNC_TOKEN'] ??
    process.env['LEAD_WEBHOOK_BEARER_TOKEN'] ??
    process.env['LEAD_WEBHOOK_TOKEN'] ??
    null
  )
}

function authenticate(req: Request): boolean {
  const presented = extractPresentedKey(req)
  const token = configuredToken()
  if (!presented || !token) return false
  return constantTimeEqual(presented, token)
}

async function handlePost(req: Request): Promise<Response> {
  if (!authenticate(req)) return new Response('unauthorised', { status: 401 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('invalid json', { status: 400 })
  }

  const result = await ingestMediAccount({ db, raw: body, actorId: 'system:medi-endpoint' })
  if (!result.accepted) {
    return new Response('payload has no usable account email or phone', { status: 400 })
  }
  if (result.deduped) {
    return Response.json({ ok: true, deduped: true })
  }
  return Response.json({ ok: true, status: 'received', id: result.eventId })
}

export const POST = withSentry(handlePost, { provider: 'medi', surface: 'webhook' })
