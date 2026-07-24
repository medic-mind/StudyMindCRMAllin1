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
  isComplaintChannel,
  resolveComplaintAutoRaiseCutoff,
  shouldAutoRaiseComplaint,
} from './channel-rules'
import type { StructuredComplaint } from './complaint-parse'
import { matchContactByCandidate, type MatchCandidate } from './match'

/**
 * Resolve the customer from the parsed CLIENT identity (email → phone → name,
 * then the guardian's phone/name). These are the authoritative details the
 * agent typed into the summary, so a match here beats the generic mention link.
 * Unambiguous-only (§3) — matchContactByCandidate returns null on ambiguity.
 */
async function matchContactFromStructured(s: StructuredComplaint): Promise<string | null> {
  const candidates: MatchCandidate[] = [
    { name: s.clientName, email: s.clientEmail, phone: s.clientPhone },
    { name: s.guardianName, phone: s.guardianPhone },
  ]
  for (const c of candidates) {
    if (!c.name && !c.email && !c.phone) continue
    const out = await matchContactByCandidate(db, c)
    if (out.contactId) return out.contactId
  }
  return null
}

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
  /**
   * This message is a REPLY inside a thread (its `thread_ts` differs from its
   * own `ts`), not the thread's starting message. A complaint is opened only
   * from the thread's STARTING message — the reply's body is the follow-up, not
   * a new complaint (operator direction 2026-07). Replies are still archived as
   * mentions/summaries by the caller; they just never spawn their own Complaint
   * (which used to create one complaint per reply, each mis-attributed to
   * whoever the reply happened to name). Defaults to false = treat as a root.
   */
  isThreadReply?: boolean
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

  // Cheap channel gate before any parse / DB match.
  if (!isComplaintChannel(input.channelName)) return { raised: false, complaintId: null }

  // Only the thread's STARTING message opens a complaint. A reply is the
  // follow-up conversation, not a new complaint — raising one per reply flooded
  // the queue and mis-attributed each to whoever the reply named (the "every
  // reply went to Neslie" bug). Replies are still captured as mentions upstream.
  if (input.isThreadReply) return { raised: false, complaintId: null }

  const sourceKey = `slack:${input.channelId}:${input.slackTs}`
  const existing = await db.complaint
    .findUnique({ where: { sourceKey }, select: { id: true } })
    .catch(() => null)
  if (existing) return { raised: false, complaintId: existing.id }

  // Parse the message into a (possibly structured) draft, then resolve the
  // customer. Prefer a contact matched on the parsed CLIENT identity over the
  // generic mention link so the complaint lands on the right person — the
  // authoritative details ("Client Email: …", "Client Name and Number: …") are
  // in the summary itself.
  const draft = buildComplaintDraft({
    messageText: input.messageText,
    aiCategory: input.aiCategory ?? null,
  })
  let contactId: string | null = input.contactId ?? null
  if (draft.structured) {
    const better = await matchContactFromStructured(draft.structured).catch(() => null)
    if (better) contactId = better
  }

  // Full gate: complaint channel + recency/cutoff + a contact to log against.
  if (
    !shouldAutoRaiseComplaint({
      channelName: input.channelName,
      contactId,
      occurredAt: input.occurredAt,
      now,
      cutoff,
    })
  ) {
    return { raised: false, complaintId: null }
  }
  const cId = contactId!

  try {
    const id = createId()
    await db.complaint.create({
      data: {
        id,
        contactId: cId,
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
        contactId: cId,
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
      after: { contactId: cId, sourceKey, auto: true, channelName: input.channelName },
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
