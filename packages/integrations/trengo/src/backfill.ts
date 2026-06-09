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
import { splitDisplayName } from '@studymind/core/contact/from-call'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientForAgent, type TrengoClient } from './client'

interface BackfillRequestedData {
  jobId: string
  provider: 'trengo'
  agentId: string | null
  windowFrom: string
  windowTo: string
  /**
   * Manual import only: create a lightweight Contact for a conversation whose
   * sender is not already in the CRM (instead of skipping it). The auto-on-
   * connect 90-day backfill leaves this false and keeps its "matched only"
   * behaviour.
   */
  createContacts?: boolean
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
    const createContacts = data.createContacts ?? false
    if (!agentId) {
      await markBackfillFailed(db, jobId, 'trengo backfill requires agentId', jobId)
      return { skipped: true, reason: 'no_agent_id' }
    }

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    let created = 0
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
          try {
            const result = await step.run(`conv-${conv.id}`, async () =>
              processConversation({
                client,
                conv,
                jobId,
                createContacts,
                actorId: agentId,
              }),
            )
            processed += result.processed
            matched += result.matched
            skipped += result.skipped
            created += result.created
          } catch (err) {
            // One conversation that fails (a contact write clash, an odd
            // message shape) must not abort the whole import. Skip it and keep
            // paging so the rest of the history lands.
            skipped += 1
            logger.warn({ jobId, convId: conv.id, err }, 'trengo backfill: skipped a conversation that failed to import')
          }
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
      return { ok: true, processed, matched, skipped, created }
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
  /** Manual import: create a Contact for a sender not already in the CRM. */
  createContacts: boolean
  /** Stamped as createdById/updatedById on any Contact this creates. */
  actorId: string | null
}

async function processConversation(
  input: ProcessConversationInput,
): Promise<{ processed: number; matched: number; skipped: number; created: number }> {
  const { client, conv, createContacts } = input

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

  // Unknown sender + operator-triggered import → create a lightweight Contact
  // keyed on the sender's phone/email so the conversation has a home. The §11
  // "never auto-create a Contact from Trengo" rule is the *webhook* default
  // (spam routes); this explicit, role-gated bulk import is the deliberate
  // exception. New rows are tagged `referralSource: 'Trengo import'` so the
  // whole batch is filterable/reviewable. Dedup is the DB itself: the next
  // conversation from the same person matches the row we just created, so one
  // Contact is made per unique phone/email — and re-runs converge (the match
  // finds it, message Interactions dedupe on trengoMessageId).
  let created = 0
  if (!contactId && createContacts) {
    const newId = await createContactFromConversation(conv, input.actorId)
    if (newId) {
      contactId = newId
      created = 1
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
  return { processed, matched, skipped, created }
}

/**
 * Create a lightweight Contact from a Trengo conversation's sender details.
 * Returns the new id, or null when there is nothing to key the row on (no
 * E.164 phone and no email) — we never make nameless ghost rows. Mirrors the
 * call-channel onboarding (`resolveOrCreateContactForCall`): `kind: 'parent'`
 * is the education-CRM default an agent recategorises.
 */
async function createContactFromConversation(
  conv: TrengoConvSummary,
  actorId: string | null,
): Promise<string | null> {
  const phone = conv.contact?.phone?.trim() ?? null
  const email = conv.contact?.email?.trim().toLowerCase() ?? null
  const hasPhone = !!phone && phone.startsWith('+')
  if (!hasPhone && !email) return null

  const name = conv.contact?.name?.trim() ?? ''
  const split = name ? splitDisplayName(name) : { firstName: '', lastName: null }
  const id = createId()
  await db.contact.create({
    data: {
      id,
      kind: 'unclassified',
      firstName: split.firstName || null,
      lastName: split.lastName,
      email,
      phoneE164: hasPhone ? phone : null,
      referralSource: 'Trengo import',
      createdById: actorId,
      updatedById: actorId,
    },
  })
  return id
}

export const BACKFILL_FUNCTIONS = [trengoBackfillRequested] as const
