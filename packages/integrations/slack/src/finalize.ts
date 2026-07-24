// Terminal handling for a Slack mention the matcher could NOT resolve to a
// Contact / B2B account (ADR 0034 amendment; operator direction 2026-07 — no
// mention waits for a human).
//
// Every ingest path (live webhook, backfill, the 15-min pull) tries the same
// resolve → onboard ladder. When that ladder finds nothing, the message used to
// be PARKED as an OPEN `UnassignedSummary` row that only cleared later, if and
// when the relink cron fired (unreliable on self-hosted Inngest) or an operator
// opened the triage tray. On a self-hosted deploy those open rows just piled up
// — the operator's "553 mentions still waiting to be assigned by hand" backlog.
//
// This module makes the open queue empty *by construction*: in full-auto mode
// (the default) an unresolved mention is recorded for the archive AND resolved
// in the SAME write, so it never enters the human queue. The kill-switch
// `SLACK_TRAY_FULL_AUTO=off` restores the old "keep a substantive nameless row
// for a human" behaviour (§3). The pure decision (`resolveUnlinkedOutcome` /
// `isUnrescuableParkedRow`) lives here so it is unit-tested in isolation and
// shared with the drain (`relink.ts`).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'

import { slackTrayFullAuto } from './config'
import { isSkippableSlackNoise } from './noise'

/**
 * A parked row is UNRESCUABLE when there is genuinely nothing to match on and
 * never will be: no AI candidate name/email/phone, no name extractable from the
 * archived text (after own-brand filtering), no email/phone in the text, and the
 * text is either empty or pure Slack noise (an ack, an emoji, a bare link). A
 * human could not action such a row either, so it is auto-dismissed (audited) to
 * keep the tray a live worklist rather than an ever-growing graveyard — the
 * "smart dismiss" half of triage. A substantive but nameless message (a real
 * note that just doesn't name anyone the matcher can read) is NOT unrescuable —
 * with the kill-switch off it stays for a human to assign by hand (§3). Pure so
 * it is unit-tested in isolation.
 */
export function isUnrescuableParkedRow(input: {
  candidate: { name: string | null; email: string | null; phone: string | null }
  messageText: string | null
  extractedNames: readonly string[]
  textSignals: { email: string | null; phone: string | null }
}): boolean {
  if (input.candidate.name || input.candidate.email || input.candidate.phone) return false
  if (input.extractedNames.length > 0) return false
  if (input.textSignals.email || input.textSignals.phone) return false
  const text = input.messageText?.trim() ?? ''
  if (text.length === 0) return true
  return isSkippableSlackNoise(text)
}

export type UnlinkedReason = 'unrescuable' | 'auto_dismiss_unlinked'

/**
 * Decide what to do with a mention the matcher could NOT link. Pure so the
 * policy is unit-tested in isolation.
 *   - Always dismiss an unrescuable row (no identity + dead/noise text).
 *   - In full-auto mode (default, operator direction 2026-07) ALSO dismiss a
 *     substantive-but-nameless row, so the tray never holds a human queue.
 *   - Otherwise keep it parked for a human (§3).
 */
export function resolveUnlinkedOutcome(
  fullAuto: boolean,
  unrescuableInput: Parameters<typeof isUnrescuableParkedRow>[0],
): { dismiss: boolean; reason: UnlinkedReason | null } {
  if (isUnrescuableParkedRow(unrescuableInput)) return { dismiss: true, reason: 'unrescuable' }
  if (fullAuto) return { dismiss: true, reason: 'auto_dismiss_unlinked' }
  return { dismiss: false, reason: null }
}

/** Read the {name,email,phone} the AI/deterministic parse guessed off a row's
 *  `parsed` blob. Defensive — the shape is the slack-summary prompt output. */
export function candidateIdentityFromParsed(parsed: unknown): {
  name: string | null
  email: string | null
  phone: string | null
} {
  const p = (parsed ?? {}) as Record<string, unknown>
  const cand = (p['candidateContactIdentifier'] ?? {}) as Record<string, unknown>
  const str = (v: unknown): string | null =>
    typeof v === 'string' && v.trim().length > 0 ? v.trim() : null
  return { name: str(cand['name']), email: str(cand['email']), phone: str(cand['phone']) }
}

export interface FinalizeUnresolvedInput {
  slackTs: string
  channelId: string
  channelName: string | null
  /** The AI/deterministic parse blob (slack-summary shape) archived on the row. */
  parsed: unknown
  confidence: number
  messageText: string | null
  senderName: string | null
  /** Deterministic name candidates already extracted at ingest (own-brand
   *  filtered). Distinguishes a substantive nameless row from an unrescuable one
   *  when the kill-switch is off. */
  extractedNames?: readonly string[]
  /** Email/phone found in the message text (Slack markup understood). */
  textSignals?: { email: string | null; phone: string | null }
  actorId: string | null
  requestId: string
}

/**
 * Record an unresolved mention for the archive AND, in full-auto (default),
 * resolve it in the same operation so it never enters the human triage queue.
 * Idempotent on `(slackTs, channelId)`: an existing row is updated (its parse /
 * text refreshed) but a row a prior pass already resolved is left resolved — we
 * never re-open the queue. Returns which terminal state was applied.
 *
 * This is the source-side twin of the relink drain: the drain clears legacy open
 * rows; this stops new open rows from ever being created.
 */
export async function finalizeUnresolvedMention(
  input: FinalizeUnresolvedInput,
): Promise<{ parked: boolean; dismissed: boolean }> {
  const fullAuto = slackTrayFullAuto()
  const candidate = candidateIdentityFromParsed(input.parsed)
  const extractedNames = input.extractedNames ?? []
  const textSignals = input.textSignals ?? { email: null, phone: null }
  const { dismiss, reason } = resolveUnlinkedOutcome(fullAuto, {
    candidate,
    messageText: input.messageText,
    extractedNames,
    textSignals,
  })
  const resolvedAt = dismiss ? new Date() : null
  // A dismissed row that STILL carries an identity signal (a name / email / phone
  // the matcher couldn't resolve to a contact yet — usually because that
  // customer isn't in the CRM) is a candidate for self-healing: the re-link pass
  // will file it on the customer's timeline once they are added. A pure-noise /
  // no-identity dismissal can never match, so it's not flagged.
  const hasIdentity = Boolean(
    candidate.name ||
      candidate.email ||
      candidate.phone ||
      extractedNames.length > 0 ||
      textSignals.email ||
      textSignals.phone,
  )
  const autoLinkPending = dismiss && hasIdentity
  const key = { slackTs_channelId: { slackTs: input.slackTs, channelId: input.channelId } }

  // Never re-open a row a human (or a prior pass) already resolved.
  const existing = await db.unassignedSummary.findUnique({
    where: key,
    select: { resolvedAt: true },
  })
  if (existing?.resolvedAt) return { parked: false, dismissed: false }

  // Atomic create-or-update on the unique (slackTs, channelId) key, so two
  // ingest paths racing the same message can't hit the unique constraint. The
  // update branch never clears an existing resolvedAt (it only ever SETS one),
  // so this is safe to re-run.
  const shared = {
    parsed: input.parsed as object,
    confidence: input.confidence,
    messageText: input.messageText,
    senderName: input.senderName,
    ...(input.channelName ? { channelName: input.channelName } : {}),
  }
  const row = await db.unassignedSummary.upsert({
    where: key,
    create: {
      id: createId(),
      slackTs: input.slackTs,
      channelId: input.channelId,
      channelName: input.channelName,
      parsed: input.parsed as object,
      confidence: input.confidence,
      messageText: input.messageText,
      senderName: input.senderName,
      resolvedAt,
      autoLinkPending,
    },
    update: {
      ...shared,
      ...(resolvedAt ? { resolvedAt, autoLinkPending } : {}),
    },
    select: { id: true },
  })

  if (resolvedAt) {
    await writeAuditLogEntry(db, {
      actorId: input.actorId,
      action: 'slack_summary.dismissed',
      target: { type: 'UnassignedSummary', id: row.id },
      requestId: input.requestId,
      after: { auto: true, reason, channelId: input.channelId, atIngest: true },
    })
  }

  return { parked: !dismiss, dismissed: dismiss }
}
