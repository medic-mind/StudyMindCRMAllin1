// Retroactive "Resync from Gmail" for email Conversation heads (ADR 0021).
//
// The live history sync only touches threads that CHANGED since the last
// historyId, and a head created before flag/label capture keeps its stale state
// (every thread "open", no label chips). This job walks the existing email heads
// for a mailbox and re-reads each thread's CURRENT Gmail state — archive / read /
// star / trash AND custom labels — converging the head onto Gmail. It writes
// ONLY to the head (no Interaction rows), so it can never duplicate timeline
// messages. Keyset-paginated + self-rescheduling so a large mailbox drains over
// several invocations.

import { applyMailFlagsToConversation } from '@studymind/core/mail'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { createClientForAgent, customLabelNames } from './client'
import { DELETED_THREAD_FLAGS, deriveThreadFlags } from './thread-flags'

interface ResyncRequestedData {
  mailAccountId: string
  gmailMailboxId: string
  agentId: string
  address: string
  requestId: string
  cursor?: { lastMessageAt: string; id: string } | null
}

/** Heads refreshed per invocation — each costs one Gmail threads.get, so this
 *  is bounded to stay within rate limits; the job reschedules for the rest. */
const RESYNC_BATCH = 60

export const gmailResyncThreads = inngest.createFunction(
  {
    id: 'gmail/resync-threads',
    name: 'Resync email conversation heads from Gmail (flags + labels)',
    concurrency: { limit: 2 },
    retries: 2,
  },
  { event: 'gmail/resync-threads.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as ResyncRequestedData
    const cursor = data.cursor ?? null

    // The id→name label map once per invocation (drives the label chips).
    const labelMap = await step.run('load-labels', async () => {
      const client = await createClientForAgent({
        agentId: data.agentId,
        address: data.address,
        purpose: 'gmail.resync',
        requestId: data.requestId,
      })
      const labels = await client.listLabels()
      return Object.fromEntries(labels.map((l) => [l.id, l.name]))
    })
    const idToName = new Map(Object.entries(labelMap))

    const page = await step.run('load-heads', async () =>
      db.conversation.findMany({
        where: {
          provider: 'email',
          mailAccountId: data.mailAccountId,
          ...(cursor
            ? {
                OR: [
                  { lastMessageAt: { lt: new Date(cursor.lastMessageAt) } },
                  {
                    AND: [
                      { lastMessageAt: new Date(cursor.lastMessageAt) },
                      { id: { lt: cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: RESYNC_BATCH + 1,
        select: { id: true, externalThreadId: true, lastMessageAt: true },
      }),
    )

    const hasMore = page.length > RESYNC_BATCH
    const heads = hasMore ? page.slice(0, RESYNC_BATCH) : page

    let converged = 0
    for (const head of heads) {
      if (!head.externalThreadId) continue
      const ok = await step.run(`resync-${head.id}`, async () => {
        const client = await createClientForAgent({
          agentId: data.agentId,
          address: data.address,
          purpose: 'gmail.resync',
          requestId: data.requestId,
        })
        const state = await client.getThreadState(head.externalThreadId as string)
        const flags = state ? deriveThreadFlags(state.labelIds) : DELETED_THREAD_FLAGS
        const labels = state
          ? customLabelNames(state.labelIds, idToName)
          : []
        await applyMailFlagsToConversation(db, {
          provider: 'email',
          externalThreadId: head.externalThreadId as string,
          flags,
          syncedAt: new Date(),
          labels,
          // The authoritative folder state — the full thread label union (or
          // Trash when Gmail no longer has the thread).
          gmailLabelIds: state ? state.labelIds : ['TRASH'],
        })
        return true
      })
      if (ok) converged += 1
    }

    if (hasMore) {
      const last = heads[heads.length - 1]
      if (last) {
        await step.run('reschedule', async () =>
          inngest.send({
            name: 'gmail/resync-threads.requested',
            data: {
              ...data,
              cursor: { lastMessageAt: new Date(last.lastMessageAt).toISOString(), id: last.id },
            },
          }),
        )
      }
    }

    logger.info(
      { mailAccountId: data.mailAccountId, converged, hasMore },
      'gmail resync-threads page complete',
    )
    return { converged, hasMore }
  },
)

export const RESYNC_FUNCTIONS = [gmailResyncThreads] as const
