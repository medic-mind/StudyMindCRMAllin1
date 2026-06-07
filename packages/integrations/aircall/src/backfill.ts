// Aircall 90-day historic backfill worker (ADR 0017).
//
// Walks `GET /v1/calls?from=<unix>&order=desc` paginated, matches each call
// to a Contact by E.164 phone, persists a `call` Interaction, and (when a
// recording is available) streams it to S3 so the comprehensive customer
// view can play it back. Idempotent on Aircall call id.

import { createId } from '@paralleldrive/cuid2'

import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import {
  resolveOrCreateContactForCall,
  splitDisplayName,
} from '@studymind/core/contact/from-call'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClient, type AircallCallResource } from './client'
import { putRecording } from './s3'

interface BackfillRequestedData {
  jobId: string
  provider: 'aircall'
  agentId: string | null
  windowFrom: string
  windowTo: string
}

export const aircallBackfillRequested = inngest.createFunction(
  {
    id: 'aircall/backfill.requested',
    name: 'Backfill last 90 days of Aircall calls',
    concurrency: { limit: 2 },
    retries: 4,
  },
  { event: 'backfill/aircall.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId, windowFrom, windowTo } = data

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    let page = 1
    const fromUnix = Math.floor(new Date(windowFrom).getTime() / 1000)
    const toUnix = Math.floor(new Date(windowTo).getTime() / 1000)

    try {
      const client = createClient()
      let keepPaging = true
      while (keepPaging) {
        const calls = await step.run(`list-page-${page}`, async () => {
          const res = await client.request<{
            calls: AircallCallResource[]
            meta?: { next_page_link?: string | null; current_page?: number }
          }>(
            'GET',
            `/calls?from=${fromUnix}&to=${toUnix}&order=desc&per_page=50&page=${page}`,
          )
          return { rows: res.calls ?? [], hasNext: !!res.meta?.next_page_link }
        })

        for (const call of calls.rows) {
          try {
            const result = await step.run(`call-${call.id}`, async () =>
              processBackfillCall(call),
            )
            processed += 1
            if (result.matched) matched += 1
            else skipped += 1
          } catch (err) {
            // Belt-and-braces: one call that still fails (e.g. the Interaction
            // write itself) must not abort the rest of the import. Skip it and
            // carry on so the mirror gets everything it can.
            processed += 1
            skipped += 1
            logger.warn({ callId: call.id, err }, 'aircall backfill: skipped a call that failed to import')
          }
        }
        await step.run(`progress-${page}`, async () =>
          incrementBackfillProgress(db, jobId, {
            processed,
            matched,
            skipped,
            lastEventId: calls.rows[calls.rows.length - 1]?.id?.toString() ?? null,
          }),
        )
        keepPaging = calls.hasNext
        page += 1
      }

      await step.run('mark-completed', async () =>
        markBackfillCompleted(db, jobId, {
          processed,
          matched,
          skipped,
          totalCount: processed,
          requestId: jobId,
        }),
      )
      return { ok: true, processed, matched, skipped }
    } catch (err) {
      logger.error({ jobId, err }, 'aircall backfill failed')
      await markBackfillFailed(
        db,
        jobId,
        err instanceof Error ? err.message : 'unknown error',
        jobId,
      )
      throw err
    }
  },
)

/**
 * Persist a single Aircall call as a `call` Interaction (matched OR unmatched),
 * idempotent on the Aircall call id. Shared by the historic backfill and the
 * recurring sync so both keep the mirror complete. Returns whether a row was
 * newly created and whether it linked to a Contact.
 */
export async function processBackfillCall(
  call: AircallCallResource,
): Promise<{ created: boolean; matched: boolean }> {
  // Idempotent on aircall call id.
  const existing = await db.interaction.findFirst({
    where: {
      type: 'call',
      payload: { path: ['aircallCallId'], equals: call.id },
    },
    select: { id: true },
  })
  if (existing) return { created: false, matched: true }

  // Resolve OR create the Contact for this call's counterparty — the SAME path
  // the live webhook uses (CLAUDE.md §10), so an imported missed call from an
  // unknown number becomes a lightweight Contact too (not an orphaned row), and
  // a known number links to its existing Contact. Shared lines (>1 match)
  // return triageRequired and are never auto-merged (§41.1). The call
  // Interaction is still persisted regardless (the mirror stays COMPLETE);
  // calls with no E.164 number keep contactId null and surface in the
  // missed-calls workspace by their raw number.
  const phone = call.raw_digits?.trim() ?? null
  let contactId: string | null = null
  let familyId: string | null = null
  let triageRequired = false
  if (phone && phone.startsWith('+')) {
    try {
      const name = extractBackfillCallName(call)
      const resolved = await resolveOrCreateContactForCall(
        db,
        {
          phoneE164: phone,
          firstName: name?.firstName ?? null,
          lastName: name?.lastName ?? null,
          email: call.contact?.emails?.find((e) => e.value)?.value?.trim() || null,
        },
        { referralSource: 'Aircall', actorId: null, requestId: `aircall-import:${call.id}` },
      )
      contactId = resolved.contactId
      familyId = resolved.familyId
      triageRequired = resolved.triageRequired
    } catch {
      // A single contact-resolution failure (e.g. a unique-constraint clash
      // while auto-creating a lightweight contact) must NEVER abort the import:
      // that previously stranded the whole mirror after the last good call and
      // the 10-min sync then retried the same poison call forever. Persist the
      // call UNMATCHED instead — the mirror stays complete (§10) and the
      // missed-calls workspace surfaces it by rawDigits for manual linking.
      contactId = null
      familyId = null
      triageRequired = false
    }
  }

  // Stream recording to S3 if present and we don't already have it.
  let recordingS3Key: string | null = null
  if (call.recording) {
    try {
      const res = await safeFetch(call.recording)
      if (res.ok) {
        const ct = res.headers.get('content-type') ?? 'audio/mpeg'
        const buf = Buffer.from(await res.arrayBuffer())
        const put = await putRecording({
          callId: call.id,
          body: buf,
          contentType: ct,
        })
        recordingS3Key = put.s3Key
      }
    } catch {
      // Recording fetch is best-effort during backfill; the Interaction still
      // lands without it.
    }
  }

  const occurredAt = new Date((call.ended_at ?? call.started_at) * 1000)
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'call',
      contactId,
      familyId,
      occurredAt,
      summary: `${call.direction === 'inbound' ? 'Inbound' : 'Outbound'} call`,
      payload: {
        backfill: true,
        // Self-describing provider so the analytics classifier never has to
        // infer it (CLAUDE.md §10). Aircall call ids are numeric.
        provider: 'aircall',
        interactionType: call.duration > 0 ? 'call.answered' : 'call.ended',
        aircallCallId: call.id,
        direction: call.direction,
        durationSec: call.duration,
        recordingUrl: call.recording,
        recordingS3Key,
        voicemailUrl: call.voicemail,
        rawDigits: call.raw_digits,
        triageRequired,
        transcriptText: call.transcription?.content ?? null,
      },
    },
  })
  return { created: true, matched: contactId != null }
}

/** Counterparty name from the Aircall-attached contact, when present. Mirrors
 *  the live webhook's extractor (kept local — jobs.ts imports this module, so a
 *  shared import would cycle). */
function extractBackfillCallName(
  call: AircallCallResource,
): { firstName: string | null; lastName: string | null } | null {
  const c = call.contact
  if (!c) return null
  const first = c.first_name?.trim()
  const last = c.last_name?.trim()
  if (first || last) return { firstName: first || null, lastName: last || null }
  const full = c.full_name?.trim()
  if (full) {
    const split = splitDisplayName(full)
    return { firstName: split.firstName || null, lastName: split.lastName }
  }
  return null
}

export const BACKFILL_FUNCTIONS = [aircallBackfillRequested] as const
