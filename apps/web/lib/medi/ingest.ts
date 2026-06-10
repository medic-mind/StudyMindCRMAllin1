// Shared ingestion core for the Medi Platform (UCAT portal) account sync
// (ADR 0037). The thin POST /api/contacts handler calls this: normalise →
// persist the raw payload to ProviderEvent (idempotent on the Medi user id) →
// enqueue the worker. The Contact resolve/create/annotate happens async in the
// `medi/account.received` Inngest job (CLAUDE.md §7 — handlers stay thin).

import { createId } from '@paralleldrive/cuid2'

import { normaliseMediAccount } from '@studymind/core/medi'
import type { PrismaClient } from '@studymind/db'
import { inngest } from '@studymind/jobs'

export interface IngestMediAccountArgs {
  db: PrismaClient
  /** The parsed JSON body POSTed by the portal. */
  raw: unknown
  /** Audit/trace actor — a system label for the endpoint. */
  actorId: string
}

export interface IngestMediAccountResult {
  /** The ProviderEvent key (`<event>:<mediUserId>`), or null when rejected. */
  eventId: string | null
  /** A duplicate delivery / resync of an already-seen account. */
  deduped: boolean
  /** False when the payload had no usable account identity (caller → 400). */
  accepted: boolean
}

function isUniqueViolation(err: unknown): boolean {
  return Boolean(
    err && typeof err === 'object' && 'code' in err && (err as { code?: string }).code === 'P2002',
  )
}

export async function ingestMediAccount(
  args: IngestMediAccountArgs,
): Promise<IngestMediAccountResult> {
  const { db, raw } = args
  const normalised = normaliseMediAccount(raw)
  if (!normalised) return { eventId: null, deduped: false, accepted: false }

  // Idempotent on the Medi user + event: a registration imports exactly once,
  // and a resync re-send of the same user dedupes instead of duplicating.
  const eventId = `${normalised.event}:${normalised.mediUserId}`

  const existing = await db.providerEvent.findUnique({
    where: { provider_eventId: { provider: 'medi', eventId } },
    select: { id: true },
  })
  if (existing) return { eventId, deduped: true, accepted: true }

  try {
    await db.providerEvent.create({
      data: {
        id: createId(),
        provider: 'medi',
        eventId,
        type: normalised.event,
        raw: raw as object,
        receivedAt: new Date(),
      },
    })
  } catch (err) {
    // A racing duplicate delivery lost the insert — still a dedupe, not an error.
    if (isUniqueViolation(err)) return { eventId, deduped: true, accepted: true }
    throw err
  }

  await inngest.send({ name: 'medi/account.received', data: { eventId } })
  return { eventId, deduped: false, accepted: true }
}
