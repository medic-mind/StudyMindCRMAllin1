// Retroactive scheduled-call-time repair for existing web leads.
//
// The improved "Call day"/"Call time" parser (fix #6) only helps NEW leads.
// This one-shot, self-rescheduling job re-parses each EXISTING lead's stored
// raw payload with that same parser and sets the backing pipeline card's
// `scheduledCallAt` where it is still blank — so historic enquiries that asked
// for a call time finally surface it on the board.
//
// Idempotent: it only touches cards whose `scheduledCallAt` is null, so a
// re-run converges. Year inference uses each lead's OWN submission date
// (`createdAt`), so "Friday 24 Jul" resolves relative to when they enquired,
// not today. One summary audit row at start + completion (§17 — never per-row).
//
// Triggered by `leads/backfill-call-times.requested` (admin button on the Lead
// webhook settings panel). The first invocation has no cursor; each subsequent
// one carries the id of the last lead processed.

import { writeAuditLogEntry } from '@studymind/audit'
import { londonWallToUtc, normaliseLead, type RawLeadInput } from '@studymind/core/lead'
import { db } from '@studymind/db'

import { inngest } from '../client'

const BATCH_SIZE = 500

interface RequestedData {
  jobId: string
  cursorId?: string | null
  scanned?: number
  updated?: number
}

/**
 * The UTC scheduled-call instant for a lead's raw payload, using the lead's
 * submission date as the reference for year-less / weekday call dates. Returns
 * null when the payload carries no parseable call time. Pure — unit-tested.
 */
export function scheduledCallFromLead(rawPayload: unknown, submittedAt: Date): Date | null {
  const normalised = normaliseLead(rawPayload as unknown as RawLeadInput, { now: submittedAt })
  return normalised.preferredWhen ? londonWallToUtc(normalised.preferredWhen) : null
}

export const leadBackfillCallTimes = inngest.createFunction(
  {
    id: 'leads/backfill-call-times',
    name: 'Backfill scheduled call times onto existing lead cards',
    // Single runner — the function id is the advisory lock so concurrent
    // invocations queue rather than race.
    concurrency: { limit: 1 },
    retries: 3,
  },
  { event: 'leads/backfill-call-times.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as RequestedData
    const { jobId } = data
    const cursorId = data.cursorId ?? null
    const scannedSoFar = data.scanned ?? 0
    const updatedSoFar = data.updated ?? 0

    if (!cursorId) {
      await step.run('audit-start', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'lead.call_times_backfill_requested',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { batchSize: BATCH_SIZE },
        }),
      )
    }

    // Next page of leads that produced a card. Keyset on id. Not wrapped in
    // step.run — the query is idempotent and Inngest jsonifies step results.
    const leads = await db.lead.findMany({
      where: {
        cardId: { not: null },
        ...(cursorId ? { id: { gt: cursorId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      select: { id: true, cardId: true, rawPayload: true, createdAt: true },
    })

    if (leads.length === 0) {
      await step.run('audit-complete', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'lead.call_times_backfilled',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { scanned: scannedSoFar, updated: updatedSoFar },
        }),
      )
      logger.info({ jobId, scanned: scannedSoFar, updated: updatedSoFar }, 'lead call-time backfill done')
      return { ok: true, scanned: scannedSoFar, updated: updatedSoFar }
    }

    // Only cards that still have no scheduled call are candidates (idempotent).
    const cardIds = leads.map((l) => l.cardId).filter((id): id is string => Boolean(id))
    const blankCards = await db.card.findMany({
      where: { id: { in: cardIds }, scheduledCallAt: null, archivedAt: null },
      select: { id: true },
    })
    const blank = new Set(blankCards.map((c) => c.id))

    let updated = 0
    for (const lead of leads) {
      if (!lead.cardId || !blank.has(lead.cardId)) continue
      const when = scheduledCallFromLead(lead.rawPayload, lead.createdAt)
      if (!when) continue
      // Re-check null in the write so a concurrent set never gets clobbered.
      const res = await db.card.updateMany({
        where: { id: lead.cardId, scheduledCallAt: null },
        data: { scheduledCallAt: when },
      })
      updated += res.count
    }

    const nextCursor = leads[leads.length - 1]!.id
    const nextScanned = scannedSoFar + leads.length
    const nextUpdated = updatedSoFar + updated

    await step.sendEvent('schedule-next-batch', {
      name: 'leads/backfill-call-times.requested',
      data: { jobId, cursorId: nextCursor, scanned: nextScanned, updated: nextUpdated },
    })

    return { ok: true, batch: leads.length, updated, scanned: nextScanned }
  },
)

export const LEAD_CALL_TIME_BACKFILL_FUNCTIONS = [leadBackfillCallTimes]
