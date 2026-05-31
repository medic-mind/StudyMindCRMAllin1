// ADR 0020 Phase 2c — backfill conversation heads from existing Interactions.
//
// One-shot migration job that walks every Trengo-shaped Interaction in
// chronological order and replays it onto the Conversation head via the
// existing `applyEventToConversation`. Idempotent: re-running it converges
// to the same state because the merger is monotonic (CLAUDE.md §11) and the
// head is keyed on trengoTicketId.
//
// The function batches 1000 rows per invocation and self-schedules the next
// batch with a `(occurredAt, id)` cursor in the event payload, mirroring
// CLAUDE.md §27's pagination shape. Concurrency is capped at 1 so the
// function id itself acts as the advisory lock — two runners cannot race.
//
// Triggered by `migration/backfill-conversation-heads.requested`. The first
// invocation has no cursor; subsequent ones carry the cursor of the last
// row processed.
//
// Audit: one row at start, one at completion. Per-row writes are NOT audited
// (CLAUDE.md §17 — backfills can touch hundreds of thousands of rows).

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { applyEventToConversation, type ApplyEventInput } from './conversation-head'
import { isTrengoChannel, type TrengoEventName } from './types'

const BATCH_SIZE = 1000

interface BackfillRequestedData {
  jobId: string
  cursor?: { occurredAt: string; id: string } | null
  processed?: number
}

/**
 * Map a Prisma Interaction.type to the Trengo event name our merger expects.
 * Returns null for types we don't know how to replay (kept for forward-compat
 * — the field selector below already filters to known types). Exported for
 * tests.
 */
export function dbTypeToEventName(
  dbType: string,
  payload: Record<string, unknown>,
): TrengoEventName | null {
  switch (dbType) {
    case 'message': {
      const it = payload['interactionType']
      if (it === 'message.outbound') return 'message.outbound'
      return 'message.inbound'
    }
    case 'ticket_assigned':
      return 'ticket.assigned'
    case 'ticket_closed':
      return 'ticket.closed'
    case 'ticket_reopened':
      return 'ticket.reopened'
    case 'label_added':
      return 'label.added'
    case 'label_removed':
      return 'label.removed'
    default:
      return null
  }
}

export interface InteractionRow {
  id: string
  type: string
  occurredAt: Date
  contactId: string | null
  familyId: string | null
  payload: unknown
}

/**
 * Translate one Interaction row into the input the conversation-head merger
 * expects. Returns null when the row carries no replayable ticket id or
 * resolves to an unknown event type — those rows are skipped (counted) by
 * the backfill loop. Exported for tests.
 */
export function rowToInput(row: InteractionRow): ApplyEventInput | null {
  const payload = (row.payload ?? {}) as Record<string, unknown>
  const ticketId =
    typeof payload['ticketId'] === 'number' ? payload['ticketId'] : null
  if (ticketId === null) return null
  const eventName = dbTypeToEventName(row.type, payload)
  if (!eventName) return null
  const channelRaw =
    typeof payload['channel'] === 'string' ? payload['channel'] : null
  const channel =
    channelRaw && isTrengoChannel(channelRaw) ? channelRaw : null
  const trengoAssigneeId =
    typeof payload['assigneeId'] === 'number'
      ? (payload['assigneeId'] as number)
      : typeof payload['trengoAssigneeId'] === 'number'
        ? (payload['trengoAssigneeId'] as number)
        : null
  const subject =
    typeof payload['subject'] === 'string' ? (payload['subject'] as string) : null
  const label =
    typeof payload['label'] === 'object' && payload['label'] !== null
      ? typeof (payload['label'] as Record<string, unknown>)['name'] === 'string'
        ? ((payload['label'] as Record<string, unknown>)['name'] as string)
        : null
      : typeof payload['label'] === 'string'
        ? (payload['label'] as string)
        : null

  return {
    ticketId,
    eventName,
    occurredAt: row.occurredAt,
    channel,
    contactId: row.contactId,
    familyId: row.familyId,
    trengoAssigneeId,
    subject,
    label,
  }
}

export const backfillConversationHeads = inngest.createFunction(
  {
    id: 'migration/backfill-conversation-heads',
    name: 'Backfill Conversation heads from existing Interactions',
    // Single runner — function id is the advisory lock so concurrent
    // invocations are queued by Inngest rather than racing.
    concurrency: { limit: 1 },
    retries: 4,
  },
  { event: 'migration/backfill-conversation-heads.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId } = data
    const cursor = data.cursor ?? null
    const processedSoFar = data.processed ?? 0

    if (!cursor) {
      await step.run('audit-start', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'migration.conversation_head_backfill_started',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { batchSize: BATCH_SIZE },
        }),
      )
    }

    // Fetch the next batch. Not wrapped in `step.run` because Inngest
    // jsonifies step return values (Date → string), and the query is
    // idempotent on its own — a function retry simply re-fetches the same
    // window. The apply loop below is also safe to re-execute because
    // `applyEventToConversation` is monotonic at the row level.
    const rows: InteractionRow[] = await db.interaction.findMany({
      where: {
        deletedAt: null,
        type: {
          in: [
            'message',
            'ticket_assigned',
            'ticket_closed',
            'ticket_reopened',
            'label_added',
            'label_removed',
          ],
        },
        ...(cursor
          ? {
              OR: [
                { occurredAt: { gt: new Date(cursor.occurredAt) } },
                {
                  AND: [
                    { occurredAt: new Date(cursor.occurredAt) },
                    { id: { gt: cursor.id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: {
        id: true,
        type: true,
        occurredAt: true,
        contactId: true,
        familyId: true,
        payload: true,
      },
    })

    if (rows.length === 0) {
      await step.run('audit-complete', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'migration.conversation_head_backfill_completed',
          target: { type: 'System', id: jobId },
          requestId: jobId,
          after: { processed: processedSoFar },
        }),
      )
      logger.info({ jobId, processed: processedSoFar }, 'conversation-head backfill done')
      return { ok: true, processed: processedSoFar }
    }

    // Resolve trengoUserId → CRM user once per batch and cache. Most batches
    // touch a single conversation in a single ticket, so the cache is small.
    const assigneeCache = new Map<number, string | null>()
    const resolveAssignee = async (trengoUserId: number): Promise<string | null> => {
      if (assigneeCache.has(trengoUserId)) return assigneeCache.get(trengoUserId) ?? null
      const u = await db.user.findUnique({
        where: { trengoUserId },
        select: { id: true },
      })
      assigneeCache.set(trengoUserId, u?.id ?? null)
      return u?.id ?? null
    }

    let applied = 0
    let skipped = 0
    for (const row of rows) {
      const input = rowToInput(row)
      if (!input) {
        skipped += 1
        continue
      }
      if (
        input.eventName === 'ticket.assigned' &&
        typeof input.trengoAssigneeId === 'number' &&
        !input.assigneeUserId
      ) {
        input.assigneeUserId = await resolveAssignee(input.trengoAssigneeId)
      }
      await applyEventToConversation(db, input)
      applied += 1
    }

    const last = rows[rows.length - 1]!
    const nextCursor = { occurredAt: last.occurredAt.toISOString(), id: last.id }
    const nextProcessed = processedSoFar + applied + skipped

    await step.sendEvent('schedule-next-batch', {
      name: 'migration/backfill-conversation-heads.requested',
      data: { jobId, cursor: nextCursor, processed: nextProcessed },
    })

    return {
      ok: true,
      applied,
      skipped,
      batchSize: rows.length,
      nextCursor,
      processedSoFar: nextProcessed,
    }
  },
)
