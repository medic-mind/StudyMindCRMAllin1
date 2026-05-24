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
          const result = await step.run(`call-${call.id}`, async () =>
            processBackfillCall(call),
          )
          processed += 1
          if (result.matched) matched += 1
          else skipped += 1
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

async function processBackfillCall(
  call: AircallCallResource,
): Promise<{ matched: boolean }> {
  // Idempotent on aircall call id.
  const existing = await db.interaction.findFirst({
    where: {
      type: 'call',
      payload: { path: ['aircallCallId'], equals: call.id },
    },
    select: { id: true },
  })
  if (existing) return { matched: true }

  // E.164 match (CLAUDE.md §10).
  const phone = call.raw_digits?.trim()
  if (!phone || !phone.startsWith('+')) return { matched: false }

  const contacts = await db.contact.findMany({
    where: { phoneE164: phone, deletedAt: null },
    select: {
      id: true,
      familyMembers: { select: { familyId: true } },
      billingForFamily: { select: { id: true } },
    },
  })
  if (contacts.length === 0) return { matched: false }

  const familyIds = new Set<string>()
  for (const c of contacts) {
    for (const m of c.familyMembers) familyIds.add(m.familyId)
    for (const f of c.billingForFamily) familyIds.add(f.id)
  }
  const familyId = familyIds.size === 1 ? [...familyIds][0] ?? null : null
  const contactId = contacts.length === 1 ? contacts[0]?.id ?? null : null
  const triageRequired = contacts.length > 1

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
  return { matched: true }
}

export const BACKFILL_FUNCTIONS = [aircallBackfillRequested] as const
