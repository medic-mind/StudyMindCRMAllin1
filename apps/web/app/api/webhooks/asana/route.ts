// Asana webhook handler. CLAUDE.md §7.1, §13.
//
// Two phases:
// 1. Handshake — Asana sends X-Hook-Secret on registration. We persist the
//    secret keyed by the project gid in the URL (?project=GID) and echo it
//    back in the X-Hook-Secret response header. Failing to echo this breaks
//    webhook setup.
// 2. Steady state — verify signature with the stored secret, filter by
//    allowed projects, upsert ProviderEvent per event, enqueue Inngest, 200.

import { createId } from '@paralleldrive/cuid2'

import { withSentry } from '@studymind/core/observability/sentry'
import { upsertProviderEvent } from '@studymind/core/provider-events'
import { isAllowedProject } from '@studymind/integration-asana/config'
import { asanaEventId } from '@studymind/integration-asana/types'
import {
  SECRET_HEADER,
  SIGNATURE_HEADER,
  verifyAndParse,
} from '@studymind/integration-asana/webhook'
import { inngest } from '@studymind/jobs'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const POST = withSentry(handlePost, { provider: 'asana', surface: 'webhook' })

async function handlePost(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const projectGid = url.searchParams.get('project') ?? ''

  // 1. Handshake. Asana POSTs an empty body with only X-Hook-Secret.
  const handshakeSecret = req.headers.get(SECRET_HEADER)
  const raw = await req.text()
  if (handshakeSecret && raw === '') {
    if (!projectGid || !isAllowedProject(projectGid)) {
      return new Response('project not allowed', { status: 400 })
    }
    await db.asanaWebhook.create({
      data: {
        id: createId(),
        projectId: projectGid,
        webhookSecret: handshakeSecret,
      },
    })
    return new Response('', {
      status: 200,
      headers: { [SECRET_HEADER]: handshakeSecret },
    })
  }

  // 2. Steady state. Look up the per-webhook secret for this project.
  if (!projectGid || !isAllowedProject(projectGid)) {
    return new Response('project not allowed', { status: 400 })
  }
  const wh = await db.asanaWebhook.findFirst({
    where: { projectId: projectGid },
    orderBy: { createdAt: 'desc' },
    select: { webhookSecret: true },
  })
  if (!wh) {
    // No registered webhook for this project — refuse rather than 200 so
    // Asana surfaces the misconfiguration in its admin UI.
    return new Response('webhook not registered', { status: 400 })
  }

  const signature = req.headers.get(SIGNATURE_HEADER)
  const result = verifyAndParse(raw, signature, wh.webhookSecret)
  if (!result.ok) {
    return new Response('invalid signature', { status: 400 })
  }

  // Asana batches multiple events per delivery. Persist + enqueue each.
  for (const ev of result.batch.events) {
    if (ev.resource.resource_type !== 'task') continue
    const eventId = asanaEventId(ev)
    const upsert = await upsertProviderEvent(db, {
      provider: 'asana',
      eventId,
      type: `task.${ev.action}`,
      raw: ev as unknown,
      receivedAt: new Date(ev.created_at),
    })
    await inngest.send({
      name: 'asana/event.received',
      data: {
        eventId,
        providerEventRowId: upsert.id,
        type: `task.${ev.action}`,
        projectGid,
      },
    })
  }

  return Response.json({ ok: true })
}
