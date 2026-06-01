// Snooze resurface cron (ADR 0020 Phase 6g). CLAUDE.md §11, §17.
//
// Every 5 minutes, flip any `snoozed` conversation whose `snoozedUntil` has
// passed back to `open` so it returns to the active inbox. A new inbound
// message also resurfaces a snoozed conversation immediately (handled in the
// webhook job) — this cron is the time-based path.
//
// Concurrency 1 (the function id is the lock). Bounded at 500 rows/tick; if a
// huge backlog ever builds, successive ticks drain it. Pure DB work + an SSE
// nudge per resurfaced row so open inboxes update without a refresh.

import { publishConversationUpdate } from '@studymind/core/realtime'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

const BATCH = 500

export const trengoUnsnoozeDue = inngest.createFunction(
  {
    id: 'trengo/unsnooze-due',
    name: 'Trengo: resurface due snoozed conversations',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/5 * * * *' },
  async ({ step, logger }) => {
    const now = new Date()
    const due = await step.run('list-due', async () =>
      db.conversation.findMany({
        where: { status: 'snoozed', snoozedUntil: { lte: now } },
        orderBy: { snoozedUntil: 'asc' },
        take: BATCH,
        select: { id: true, contactId: true, lastMessageAt: true },
      }),
    )
    if (due.length === 0) return { unsnoozed: 0 }

    await step.run('unsnooze', async () =>
      db.conversation.updateMany({
        where: {
          id: { in: due.map((d) => d.id) },
          status: 'snoozed',
          snoozedUntil: { lte: now },
        },
        data: { status: 'open', snoozedUntil: null },
      }),
    )

    // Nudge open inboxes so the resurfaced rows appear without a refresh.
    for (const d of due) {
      publishConversationUpdate({
        id: d.id,
        trengoTicketId: null,
        // `step.run` jsonifies its return, so this is already an ISO string.
        lastMessageAt: d.lastMessageAt ?? null,
        contactId: d.contactId,
      })
    }

    logger.info({ unsnoozed: due.length }, 'trengo unsnooze-due tick complete')
    return { unsnoozed: due.length }
  },
)
