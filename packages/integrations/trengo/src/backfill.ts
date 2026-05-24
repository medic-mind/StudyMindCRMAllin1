// Trengo 90-day historic backfill worker (ADR 0017).
//
// Uses the agent's own Trengo token to walk `/conversations?created_at_after`,
// fetch each conversation's messages, match the conversation's contact to a
// CRM Contact by phone+email, and persist `message` Interactions. Idempotent
// on Trengo message id.

import { createId } from '@paralleldrive/cuid2'

import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientForAgent, type TrengoClient } from './client'

interface BackfillRequestedData {
  jobId: string
  provider: 'trengo'
  agentId: string | null
  windowFrom: string
  windowTo: string
}

interface TrengoConvSummary {
  id: number
  channel?: string
  contact?: { phone?: string; email?: string; name?: string }
}

interface TrengoMessageRow {
  id: number
  ticket_id?: number
  conversation_id?: number
  body?: string
  channel?: string
  direction?: string
  created_at?: string
  contact?: { phone?: string; email?: string; name?: string }
}

export const trengoBackfillRequested = inngest.createFunction(
  {
    id: 'trengo/backfill.requested',
    name: 'Backfill last 90 days of Trengo conversations',
    concurrency: { limit: 2 },
    retries: 4,
  },
  { event: 'backfill/trengo.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId, agentId, windowFrom } = data
    if (!agentId) {
      await markBackfillFailed(db, jobId, 'trengo backfill requires agentId', jobId)
      return { skipped: true, reason: 'no_agent_id' }
    }

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    let page = 1

    try {
      const client = await createClientForAgent({
        agentId,
        purpose: 'trengo.backfill',
        requestId: jobId,
      })
      const since = new Date(windowFrom).toISOString().slice(0, 10) // YYYY-MM-DD

      let keepPaging = true
      while (keepPaging) {
        const convs = await step.run(`list-conversations-${page}`, async () => {
          const res = await client.request<{ data: TrengoConvSummary[]; meta?: { last_page?: number } }>(
            'GET',
            `/conversations?created_at_after=${since}&page=${page}&per_page=50`,
          )
          return {
            rows: res.data ?? [],
            hasNext: !!res.meta?.last_page && page < res.meta.last_page,
          }
        })

        for (const conv of convs.rows) {
          const result = await step.run(`conv-${conv.id}`, async () =>
            processConversation({ client, conv, jobId }),
          )
          processed += result.processed
          matched += result.matched
          skipped += result.skipped
        }
        await step.run(`progress-${page}`, async () =>
          incrementBackfillProgress(db, jobId, {
            processed,
            matched,
            skipped,
            lastEventId: convs.rows[convs.rows.length - 1]?.id?.toString() ?? null,
          }),
        )
        keepPaging = convs.hasNext
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
      logger.error({ jobId, agentId, err }, 'trengo backfill failed')
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

interface ProcessConversationInput {
  client: TrengoClient
  conv: TrengoConvSummary
  jobId: string
}

async function processConversation(
  input: ProcessConversationInput,
): Promise<{ processed: number; matched: number; skipped: number }> {
  const { client, conv } = input

  // Match conversation contact (phone first, email fallback — §11).
  const phone = conv.contact?.phone?.trim() ?? null
  const email = conv.contact?.email?.trim().toLowerCase() ?? null
  let contactId: string | null = null
  let familyId: string | null = null
  if (phone && phone.startsWith('+')) {
    const c = await db.contact.findFirst({
      where: { phoneE164: phone, deletedAt: null },
      select: { id: true, familyMembers: { select: { familyId: true } } },
    })
    if (c) {
      contactId = c.id
      familyId = c.familyMembers[0]?.familyId ?? null
    }
  }
  if (!contactId && email) {
    const c = await db.contact.findFirst({
      where: { email, deletedAt: null },
      select: { id: true, familyMembers: { select: { familyId: true } } },
    })
    if (c) {
      contactId = c.id
      familyId = c.familyMembers[0]?.familyId ?? null
    }
  }

  // Pull messages for this conversation.
  const res = await client.request<{ data: TrengoMessageRow[] }>(
    'GET',
    `/conversations/${conv.id}/messages?per_page=200`,
  )
  const messages = res.data ?? []
  let processed = 0
  let matched = 0
  let skipped = 0

  for (const m of messages) {
    processed += 1
    if (!contactId) {
      skipped += 1
      continue
    }
    const existing = await db.interaction.findFirst({
      where: { payload: { path: ['trengoMessageId'], equals: m.id } },
      select: { id: true },
    })
    if (existing) {
      matched += 1
      continue
    }
    const direction =
      m.direction === 'outbound' ? 'message.outbound' : 'message.inbound'
    await db.interaction.create({
      data: {
        id: createId(),
        type: 'message',
        contactId,
        familyId,
        occurredAt: m.created_at ? new Date(m.created_at) : new Date(),
        summary: (m.body ?? '').slice(0, 280),
        payload: {
          backfill: true,
          interactionType: direction,
          trengoMessageId: m.id,
          ticketId: m.ticket_id ?? conv.id,
          channel: m.channel ?? conv.channel ?? null,
          body: m.body ?? null,
        },
      },
    })
    matched += 1
  }
  return { processed, matched, skipped }
}

export const BACKFILL_FUNCTIONS = [trengoBackfillRequested] as const
