// Auto-raise a Complaint from a complaint-channel Slack mention (ADR 0042).
//
// Executor for the pure decisions in channel-rules.ts. Called best-effort by
// every ingestion path (live webhook, recurring pull, backfill, relink) AFTER a
// mention has linked to a Contact: a complaint failure must never fail the
// message archive itself. Idempotent on `Complaint.sourceKey`
// ("slack:<channelId>:<ts>"), so the overlapping pull windows and replays
// converge on ONE complaint per Slack message. Mirrors the human log-complaint
// flow (complaint router `create`): open/medium complaint + a timeline note on
// the contact + a `complaint.created` audit row — system-authored
// (createdById null, §19), so it is obvious a human never typed it.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { logger } from '@studymind/core/logger'
import { db } from '@studymind/db'

import {
  buildComplaintDraft,
  resolveComplaintAutoRaiseCutoff,
  shouldAutoRaiseComplaint,
} from './channel-rules'

export interface AutoComplaintInput {
  contactId: string | null | undefined
  channelId: string
  channelName: string | null
  slackTs: string
  messageText: string
  /** AI slack-summary category when the AI ran ('billing', 'complaint', …). */
  aiCategory?: string | null
  occurredAt: Date
  now?: Date
  /** Go-live cutoff; defaults to the env-resolved value. Passed explicitly by
   *  the reprocess backfill so a re-run uses the same window. */
  cutoff?: Date
}

export interface AutoComplaintResult {
  raised: boolean
  complaintId: string | null
}

export async function maybeRaiseComplaintFromSlack(
  input: AutoComplaintInput,
): Promise<AutoComplaintResult> {
  const now = input.now ?? new Date()
  const cutoff =
    input.cutoff ?? resolveComplaintAutoRaiseCutoff(process.env['COMPLAINT_AUTO_RAISE_CUTOFF_DATE'])
  if (
    !shouldAutoRaiseComplaint({
      channelName: input.channelName,
      contactId: input.contactId,
      occurredAt: input.occurredAt,
      now,
      cutoff,
    })
  ) {
    return { raised: false, complaintId: null }
  }
  const contactId = input.contactId!
  const sourceKey = `slack:${input.channelId}:${input.slackTs}`

  try {
    const existing = await db.complaint.findUnique({
      where: { sourceKey },
      select: { id: true },
    })
    if (existing) return { raised: false, complaintId: existing.id }

    const draft = buildComplaintDraft({
      messageText: input.messageText,
      aiCategory: input.aiCategory ?? null,
    })
    const id = createId()
    await db.complaint.create({
      data: {
        id,
        contactId,
        title: draft.title,
        description: draft.description,
        status: 'open',
        severity: 'medium',
        category: draft.category,
        sourceKey,
        createdById: null,
        updatedById: null,
      },
    })
    const noteSummary = `Complaint raised: ${draft.title}`
    await db.interaction.create({
      data: {
        id: createId(),
        type: 'note',
        contactId,
        occurredAt: input.occurredAt,
        summary: noteSummary.length > 120 ? `${noteSummary.slice(0, 117)}…` : noteSummary,
        payload: {
          event: 'complaint.raised',
          kind: 'complaint',
          complaintId: id,
          body: draft.description,
          authorId: null,
          source: 'slack_auto',
          channelId: input.channelId,
          channelName: input.channelName,
          slackTs: input.slackTs,
        },
      },
    })
    await writeAuditLogEntry(db, {
      actorId: null,
      action: 'complaint.created',
      target: { type: 'Complaint', id },
      requestId: sourceKey,
      after: { contactId, sourceKey, auto: true, channelName: input.channelName },
    })
    return { raised: true, complaintId: id }
  } catch (err) {
    // A concurrent path may have won the unique sourceKey race — that is
    // convergence, not a failure. Anything else is logged and swallowed: the
    // mention archive must land regardless.
    const raced = await db.complaint
      .findUnique({ where: { sourceKey }, select: { id: true } })
      .catch(() => null)
    if (raced) return { raised: false, complaintId: raced.id }
    logger.warn(
      { sourceKey, channelName: input.channelName, err },
      'slack auto-complaint failed (mention archived regardless)',
    )
    return { raised: false, complaintId: null }
  }
}
