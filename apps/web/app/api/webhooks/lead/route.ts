// Lead capture webhook (Zapier and partners). CLAUDE.md §16.
//
// Auth: `Authorization: Bearer <LEAD_WEBHOOK_TOKEN>`, constant-time compared.
// Schema: additive only; the v2 alias delegates here for forward compatibility.
// Idempotency: dedupes on (source, email|phone, sha256(notes)) — Zapier will
// retry, and we must not double-create Leads.
// Side effects: persists a Lead row, writes a `lead.received` Interaction
// (orphaned — no Contact yet), audits.

import { createHash, timingSafeEqual } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'
import { z } from 'zod'

import { writeAuditLogEntry } from '@studymind/audit'
import { withSentry } from '@studymind/core/observability/sentry'

import { db } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export const LeadInput = z.object({
  source: z.string().min(1).max(200),
  name: z.string().min(1).max(200).optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().min(3).max(40).optional(),
  parentName: z.string().min(1).max(200).optional(),
  studentName: z.string().min(1).max(200).optional(),
  studentDob: z.string().min(8).max(40).optional(),
  postcode: z.string().min(2).max(20).optional(),
  ehcp: z.boolean().optional(),
  notes: z.string().max(10_000).optional(),
})

export type LeadInputT = z.infer<typeof LeadInput>

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, Buffer.alloc(bufA.length))
    return false
  }
  return timingSafeEqual(bufA, bufB)
}

function getExpectedToken(): string | null {
  return (
    process.env['LEAD_WEBHOOK_BEARER_TOKEN'] ??
    process.env['LEAD_WEBHOOK_TOKEN'] ??
    null
  )
}

export function leadIdempotencyKey(input: LeadInputT): string {
  const ident = input.email?.toLowerCase().trim() ?? input.phone?.trim() ?? ''
  const notesHash = createHash('sha256')
    .update(input.notes ?? '')
    .digest('hex')
    .slice(0, 16)
  return `${input.source}|${ident}|${notesHash}`
}

async function handlePost(req: Request): Promise<Response> {
  const expected = getExpectedToken()
  const auth = req.headers.get('authorization')
  if (!expected) {
    return new Response('lead webhook not configured', { status: 503 })
  }
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response('unauthorised', { status: 401 })
  }
  if (!constantTimeEqual(auth.slice('Bearer '.length), expected)) {
    return new Response('unauthorised', { status: 401 })
  }

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return new Response('invalid json', { status: 400 })
  }

  const parsed = LeadInput.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 },
    )
  }
  const input = parsed.data
  const dedupeKey = leadIdempotencyKey(input)

  const existing = await db.lead.findFirst({
    where: { source: input.source, name: dedupeKey },
    select: { id: true },
  })
  if (existing) {
    return Response.json({ ok: true, deduped: true, id: existing.id })
  }

  const leadId = createId()
  const requestId = createId()
  await db.$transaction(async (tx) => {
    await tx.lead.create({
      data: {
        id: leadId,
        source: input.source,
        rawPayload: input as unknown as object,
        email: input.email ?? null,
        phoneE164: input.phone ?? null,
        // `name` doubles as the stable dedupe key (sub-200 chars). The
        // human-readable name is preserved in rawPayload.name. The wire
        // schema is additive (CLAUDE.md §16) so a future migration can
        // promote a dedicated `dedupeKey` column without breaking it.
        name: dedupeKey,
      },
    })
    await tx.interaction.create({
      data: {
        id: createId(),
        type: 'note',
        contactId: null,
        familyId: null,
        occurredAt: new Date(),
        summary: `Lead received from ${input.source}`,
        payload: {
          event: 'lead.received',
          leadId,
          source: input.source,
          ehcp: input.ehcp ?? null,
        },
      },
    })
  })

  await writeAuditLogEntry(db, {
    actorId: null,
    action: 'lead.received',
    target: { type: 'Lead', id: leadId },
    requestId,
    after: {
      source: input.source,
      hasEmail: Boolean(input.email),
      hasPhone: Boolean(input.phone),
    },
  })

  return Response.json({ ok: true, id: leadId })
}

export const POST = withSentry(handlePost, { provider: 'lead', surface: 'webhook' })
