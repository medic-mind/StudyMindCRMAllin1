// Retroactive complaint opener (ADR 0042 amendment). The complaint-channel
// auto-raise (complaints.ts) only fires on messages that arrive live OR that a
// sync path evaluates for the FIRST time — a message already archived as a
// slack_summary in an earlier run short-circuits the ingest idempotency guard
// long before the complaint hook is reached, so existing complaint-channel
// mentions never became Complaint rows even after the 7-day horizon was
// widened to the go-live cutoff.
//
// This one-off, admin-triggered job closes that gap: it walks every
// contact-linked slack_summary mention on/after the cutoff, and for the ones
// in a complaint-flavoured channel it (re)runs maybeRaiseComplaintFromSlack.
// It is idempotent on Complaint.sourceKey, so re-runs converge and it never
// double-opens. Best-effort per row (a single failure never aborts the batch),
// keyset-paged, and self-rescheduling so it can never blow the Inngest step
// budget on a large history.

import { logger } from '@studymind/core/logger'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { isComplaintChannel, resolveComplaintAutoRaiseCutoff } from './channel-rules'
import { maybeRaiseComplaintFromSlack } from './complaints'
import { resolveSlackNames } from './names'

/** Rows per keyset page. */
export const COMPLAINT_REPROCESS_PAGE = 500
/** Pages per invocation before self-rescheduling (bounds the step budget). */
export const COMPLAINT_REPROCESS_MAX_PAGES = 10

interface SlackSummaryPayload {
  channelId?: unknown
  channelName?: unknown
  slackTs?: unknown
  messageText?: unknown
  category?: unknown
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

export interface ComplaintReprocessResult {
  scanned: number
  raised: number
  nextCursorId: string | null
}

/**
 * One page: re-evaluate up to COMPLAINT_REPROCESS_PAGE contact-linked
 * `slack_summary` mentions (occurredAt >= cutoff, id-keyset from `cursorId`) for
 * complaint auto-raise. channelName is read from the stored payload when
 * present, else resolved from the channel id (cached). Idempotent + best-effort
 * per row. Returns the keyset cursor for the next page (null when drained).
 */
export async function reprocessComplaintMentionsPage(
  cutoff: Date,
  cursorId: string | null,
): Promise<ComplaintReprocessResult> {
  const rows = await db.interaction.findMany({
    where: {
      type: 'slack_summary',
      contactId: { not: null },
      deletedAt: null,
      occurredAt: { gte: cutoff },
    },
    orderBy: { id: 'asc' },
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    take: COMPLAINT_REPROCESS_PAGE,
    select: { id: true, contactId: true, occurredAt: true, payload: true },
  })

  let raised = 0
  for (const row of rows) {
    try {
      const p = (row.payload ?? {}) as SlackSummaryPayload
      const channelId = str(p.channelId)
      const slackTs = str(p.slackTs)
      const messageText = str(p.messageText)
      if (!channelId || !slackTs || !messageText || !row.contactId) continue

      let channelName = str(p.channelName)
      if (!channelName) channelName = (await resolveSlackNames({ channelId })).channelName
      if (!isComplaintChannel(channelName)) continue

      const res = await maybeRaiseComplaintFromSlack({
        contactId: row.contactId,
        channelId,
        channelName,
        slackTs,
        messageText,
        aiCategory: str(p.category),
        occurredAt: row.occurredAt,
        cutoff,
      })
      if (res.raised) raised += 1
    } catch (err) {
      logger.warn(
        { interactionId: row.id, err },
        'slack complaint-reprocess: row failed — continuing',
      )
    }
  }

  const nextCursorId = rows.length === COMPLAINT_REPROCESS_PAGE ? rows[rows.length - 1]!.id : null
  return { scanned: rows.length, raised, nextCursorId }
}

export const slackBackfillComplaints = inngest.createFunction(
  {
    id: 'slack/backfill-complaints',
    name: 'Open complaints for existing complaint-channel Slack mentions',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { event: 'slack/backfill-complaints.requested' },
  async ({ event, step, logger }) => {
    const data = (event.data ?? {}) as { cursorId?: string; cutoffIso?: string }
    const cutoff = resolveComplaintAutoRaiseCutoff(
      data.cutoffIso ?? process.env['COMPLAINT_AUTO_RAISE_CUTOFF_DATE'],
    )
    let cursorId: string | null = data.cursorId ?? null
    let scanned = 0
    let raised = 0

    for (let page = 0; page < COMPLAINT_REPROCESS_MAX_PAGES; page += 1) {
      const res = await step.run(`reprocess-page-${page}`, async () =>
        reprocessComplaintMentionsPage(cutoff, cursorId),
      )
      scanned += res.scanned
      raised += res.raised
      cursorId = res.nextCursorId
      if (!cursorId) break
    }

    if (cursorId) {
      // More rows remain — carry on from the cursor in a fresh invocation so a
      // large history never exceeds the step budget.
      await step.sendEvent('continue-complaint-backfill', {
        name: 'slack/backfill-complaints.requested',
        data: { cursorId, cutoffIso: cutoff.toISOString() },
      })
    }

    logger.info({ scanned, raised, done: !cursorId }, 'slack backfill-complaints batch complete')
    return { scanned, raised, done: !cursorId }
  },
)

export const COMPLAINT_BACKFILL_FUNCTIONS = [slackBackfillComplaints] as const
