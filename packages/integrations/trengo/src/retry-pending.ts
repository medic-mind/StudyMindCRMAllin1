// Outbound retry queue (ADR 0020 Phase 7a). CLAUDE.md §11, §17.
//
// Every 5 minutes, scan for outbound Interactions whose two-phase commit
// stalled in `pending_send` and re-attempt the send through the existing
// audited outbound. Idempotent end-to-end:
//   - `sendMessage` / `changeTicketState` dedupe on `outboundRequestId`, so
//     re-calling them with the same id either picks up the existing row or
//     advances it.
//   - The retry job tracks an attempt counter on the payload and caps at
//     `MAX_ATTEMPTS` so a permanently-broken row is not pinged forever.
//   - TOKEN_EXPIRED errors are NOT retried — the agent must reconnect the
//     token first. The Interaction stays `pending_send` and the rotation
//     banner is the recovery surface.
//
// This is the recovery path for sustained Trengo downtime that exceeds
// Inngest's per-request retry envelope. Live retries inside a single
// outbound call continue to be handled by Inngest's native retries on the
// `trengo/event.received` function.

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import {
  addConversationLabel,
  assignConversation,
  closeConversation,
  removeConversationLabel,
  reopenConversation,
  sendMessage,
  sendWhatsAppTemplate,
  startConversation,
} from './outbound'
import type { TrengoChannel } from './types'

const MAX_ATTEMPTS = 5
/**
 * Version of the outbound request shape. Bumped when a sender bug is fixed
 * (v2: the documented `message` param on /tickets/:id/messages — v1 sent
 * only `body` and every reply 422'd). Rows that exhausted their attempts
 * under an OLDER shape get ONE fresh attempt budget: the failures were the
 * sender's fault, not the row's.
 */
const SEND_SHAPE_VERSION = 2
/**
 * A customer-facing message that has sat unsent for longer than this is NOT
 * auto-sent on recovery — a reply drafted yesterday going out now hits the
 * customer out of context, and a recovered backlog becomes a flurry of
 * out-of-date messages (§3: no surprise auto-sends). It is marked failed,
 * visibly, and the agent decides whether to resend. State syncs (close /
 * reopen / labels / assign) are not customer-visible and stay retryable.
 */
const MAX_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000
/** Skip rows whose last failure is too recent — give Trengo time to recover
 *  before pinging again. The Inngest cron runs every 5 minutes, so this is
 *  effectively a one-attempt-per-tick floor. */
const MIN_AGE_MS = 5 * 60 * 1000
/** Hard cap on the batch per tick so we never page the worker. */
const BATCH_LIMIT = 100

interface RetryablePayload {
  status?: string
  outboundRequestId?: string
  contactId?: string
  agentId?: string
  ticketId?: number
  channel?: string
  body?: string
  assigneeUserId?: string
  label?: string
  internalNote?: boolean
  newConversation?: boolean
  trengoChannelId?: number
  recipient?: string
  waTemplate?: {
    id?: number
    title?: string
    params?: Array<{ key?: string; value?: string }>
  }
  attempts?: number
  sendShape?: number
  lastError?: { code?: string; message?: string }
}

export const trengoRetryPendingSend = inngest.createFunction(
  {
    id: 'trengo/retry-pending-send',
    name: 'Trengo: re-send pending_send outbound Interactions',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const cutoff = new Date(Date.now() - MIN_AGE_MS)

    const candidates = await step.run('list-pending', async () =>
      db.interaction.findMany({
        where: {
          deletedAt: null,
          type: {
            in: [
              'message',
              'ticket_closed',
              'ticket_reopened',
              'ticket_assigned',
              'label_added',
              'label_removed',
            ],
          },
          updatedAt: { lt: cutoff },
          payload: { path: ['status'], equals: 'pending_send' },
        },
        orderBy: { updatedAt: 'asc' },
        take: BATCH_LIMIT,
        select: {
          id: true,
          type: true,
          contactId: true,
          occurredAt: true,
          payload: true,
        },
      }),
    )

    let retried = 0
    let skipped = 0
    let exhausted = 0
    let recovered = 0

    for (const row of candidates) {
      const payload = (row.payload ?? {}) as RetryablePayload
      let attempts = typeof payload.attempts === 'number' ? payload.attempts : 0

      // Stale customer-visible messages are never auto-sent — mark them
      // failed (visible in the thread) and move on.
      if (
        row.type === 'message' &&
        Date.now() - new Date(row.occurredAt).getTime() > MAX_MESSAGE_AGE_MS
      ) {
        await step.run(`mark-stale-${row.id}`, async () => {
          const fresh = await db.interaction.findUnique({
            where: { id: row.id },
            select: { payload: true },
          })
          const p = (fresh?.payload ?? {}) as Record<string, unknown>
          await db.interaction.update({
            where: { id: row.id },
            data: {
              payload: {
                ...p,
                attempts: MAX_ATTEMPTS,
                sendShape: SEND_SHAPE_VERSION,
                lastError: {
                  code: 'STALE_NOT_SENT',
                  message:
                    'Expired before it could be sent — not auto-sent a day later to avoid messaging the customer out of context. Resend it if still relevant.',
                },
              },
            },
          })
        })
        exhausted += 1
        continue
      }

      if (attempts >= MAX_ATTEMPTS) {
        if (payload.sendShape === SEND_SHAPE_VERSION) {
          exhausted += 1
          continue
        }
        // Exhausted under an older (buggy) request shape — retry now with a
        // fresh budget under the fixed sender.
        attempts = 0
      }
      if (payload.lastError?.code === 'TOKEN_EXPIRED') {
        skipped += 1
        continue
      }

      // WhatsApp template (HSM) rows have a recipient + waTemplate but no
      // ticket — recover via sendWhatsAppTemplate (idempotent on the same
      // outboundRequestId). Handled before the ticketId guard below.
      if (payload.waTemplate && typeof payload.waTemplate.id === 'number') {
        if (
          !row.contactId ||
          typeof payload.agentId !== 'string' ||
          typeof payload.recipient !== 'string' ||
          typeof payload.body !== 'string' ||
          typeof payload.outboundRequestId !== 'string'
        ) {
          skipped += 1
          continue
        }
        try {
          await sendWhatsAppTemplate({
            contactId: row.contactId,
            agentId: payload.agentId,
            recipient: payload.recipient,
            templateId: payload.waTemplate.id,
            templateTitle: payload.waTemplate.title ?? `Template ${payload.waTemplate.id}`,
            renderedBody: payload.body,
            params: (payload.waTemplate.params ?? []).flatMap((p) =>
              typeof p.key === 'string' && typeof p.value === 'string'
                ? [{ key: p.key, value: p.value }]
                : [],
            ),
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } catch (err) {
          await bumpAttemptCounter(row.id, attempts + 1, err)
          retried += 1
        }
        continue
      }

      // New-conversation rows have a recipient but no ticket yet — recover
      // them via startConversation (which creates the ticket). Handled before
      // the ticketId guard below.
      if (payload.newConversation === true) {
        if (
          !row.contactId ||
          typeof payload.agentId !== 'string' ||
          typeof payload.recipient !== 'string' ||
          typeof payload.channel !== 'string' ||
          typeof payload.body !== 'string' ||
          typeof payload.outboundRequestId !== 'string'
        ) {
          skipped += 1
          continue
        }
        try {
          await startConversation({
            contactId: row.contactId,
            agentId: payload.agentId,
            channel: payload.channel as TrengoChannel,
            ...(typeof payload.trengoChannelId === 'number'
              ? { trengoChannelId: payload.trengoChannelId }
              : {}),
            recipient: payload.recipient,
            body: payload.body,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } catch (err) {
          await bumpAttemptCounter(row.id, attempts + 1, err)
          retried += 1
        }
        continue
      }

      if (
        !row.contactId ||
        typeof payload.agentId !== 'string' ||
        typeof payload.ticketId !== 'number' ||
        typeof payload.outboundRequestId !== 'string'
      ) {
        // Missing the keys we need to retry idempotently. Mark exhausted
        // so we don't pick this row up every tick.
        skipped += 1
        continue
      }

      try {
        if (row.type === 'message') {
          if (typeof payload.body !== 'string' || typeof payload.channel !== 'string') {
            skipped += 1
            continue
          }
          await sendMessage({
            contactId: row.contactId,
            agentId: payload.agentId,
            ticketId: payload.ticketId,
            channel: payload.channel as 'whatsapp' | 'sms' | 'email' | 'web_chat',
            body: payload.body,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } else if (row.type === 'ticket_closed') {
          await closeConversation({
            contactId: row.contactId,
            agentId: payload.agentId,
            ticketId: payload.ticketId,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } else if (row.type === 'ticket_reopened') {
          await reopenConversation({
            contactId: row.contactId,
            agentId: payload.agentId,
            ticketId: payload.ticketId,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } else if (row.type === 'ticket_assigned') {
          if (typeof payload.assigneeUserId !== 'string') {
            skipped += 1
            continue
          }
          await assignConversation({
            contactId: row.contactId,
            agentId: payload.agentId,
            ticketId: payload.ticketId,
            assigneeUserId: payload.assigneeUserId,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        } else if (row.type === 'label_added' || row.type === 'label_removed') {
          if (typeof payload.label !== 'string') {
            skipped += 1
            continue
          }
          const fn = row.type === 'label_added' ? addConversationLabel : removeConversationLabel
          await fn({
            contactId: row.contactId,
            agentId: payload.agentId,
            ticketId: payload.ticketId,
            label: payload.label,
            requestId: payload.outboundRequestId,
          })
          recovered += 1
        }
      } catch (err) {
        // The outbound function has already written lastError to payload.
        // Bump the attempt counter so the next tick advances the cap.
        await bumpAttemptCounter(row.id, attempts + 1, err)
        retried += 1
      }
    }

    if (retried > 0 || recovered > 0 || exhausted > 0) {
      await step.run('audit-summary', async () =>
        writeAuditLogEntry(db, {
          actorId: null,
          action: 'system.job_completed',
          target: { type: 'System', id: 'trengo.retry_pending_send' },
          requestId: `trengo-retry-${cutoff.toISOString()}`,
          after: { retried, recovered, skipped, exhausted, batch: candidates.length },
        }),
      )
    }

    logger.info(
      { retried, recovered, skipped, exhausted, batch: candidates.length },
      'trengo retry-pending-send tick complete',
    )
    return { retried, recovered, skipped, exhausted, batch: candidates.length }
  },
)

async function bumpAttemptCounter(
  interactionId: string,
  nextAttempts: number,
  _err: unknown,
): Promise<void> {
  const row = await db.interaction.findUnique({
    where: { id: interactionId },
    select: { payload: true },
  })
  const payload = (row?.payload ?? {}) as Record<string, unknown>
  await db.interaction.update({
    where: { id: interactionId },
    data: {
      payload: { ...payload, attempts: nextAttempts, sendShape: SEND_SHAPE_VERSION },
    },
  })
}
