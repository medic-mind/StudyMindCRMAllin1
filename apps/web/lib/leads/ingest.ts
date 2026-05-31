// Shared lead ingestion core (ADR 0023). Used by the public POST /api/leads
// endpoint AND the Integrations "send test lead" action so both follow the
// exact same path: normalise → dedupe → persist (ProviderEvent + Lead) →
// audit → enqueue the classify job. Keeping it here means the endpoint and the
// admin test never drift.

import { createHash } from 'node:crypto'

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { normaliseLead, type RawLeadInput } from '@studymind/core/lead'
import type { PrismaClient } from '@studymind/db'
import { inngest } from '@studymind/jobs'

// 5-minute idempotency bucket: identical double-fires dedupe, a genuine
// re-enquiry later is a fresh event (the job dedupes onto the contact).
const DEDUPE_BUCKET_MS = 5 * 60 * 1000

export interface IngestLeadArgs {
  db: PrismaClient
  rawInput: RawLeadInput
  sourceId: string | null
  /** Audit actor — a lead_source id, a user id (test), or a system label. */
  actorId: string
}

export interface IngestLeadResult {
  id: string | null
  deduped: boolean
}

export async function ingestLead(args: IngestLeadArgs): Promise<IngestLeadResult> {
  const { db, rawInput, sourceId, actorId } = args
  const normalised = normaliseLead(rawInput)

  const bucket = Math.floor(Date.now() / DEDUPE_BUCKET_MS)
  const eventId = createHash('sha256')
    .update(`${normalised.source}:${JSON.stringify(rawInput.fields)}:${bucket}`)
    .digest('hex')

  const existing = await db.providerEvent.findUnique({
    where: { provider_eventId: { provider: 'lead', eventId } },
    select: { id: true },
  })
  if (existing) return { id: null, deduped: true }

  const leadId = createId()
  try {
    await db.$transaction(async (tx) => {
      await tx.providerEvent.create({
        data: {
          id: createId(),
          provider: 'lead',
          eventId,
          type: 'lead.submission',
          raw: rawInput as unknown as object,
          receivedAt: new Date(),
        },
      })
      await tx.lead.create({
        data: {
          id: leadId,
          source: normalised.source,
          rawPayload: rawInput as unknown as object,
          email: normalised.email,
          phoneE164: normalised.phoneE164,
          name: normalised.name,
          sourceId,
          landingDomain: normalised.landingDomain,
          landingUrl: normalised.landingUrl,
          landingSlug: normalised.landingSlug,
          formTitle: normalised.formTitle,
          formId: normalised.formId,
          referrer: normalised.referrer,
          utm: (normalised.utm ?? undefined) as object | undefined,
          status: 'received',
        },
      })
      if (sourceId) {
        await tx.leadSource.update({
          where: { id: sourceId },
          data: { leadCount: { increment: 1 }, lastLeadAt: new Date() },
        })
      }
    })
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: string }).code === 'P2002'
    ) {
      return { id: null, deduped: true }
    }
    throw err
  }

  await writeAuditLogEntry(db, {
    actorId,
    action: 'lead.received',
    target: { type: 'Lead', id: leadId },
    requestId: eventId,
    after: {
      source: normalised.source,
      hasEmail: Boolean(normalised.email),
      hasPhone: Boolean(normalised.phoneE164),
      landingDomain: normalised.landingDomain,
    },
  })

  await inngest.send({ name: 'lead/classify.requested', data: { leadId } })
  return { id: leadId, deduped: false }
}
