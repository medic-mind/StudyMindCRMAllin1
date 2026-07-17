// Automated triage for parked Slack mentions (ADR 0034 amendment).
//
// A mention only parks in `UnassignedSummary` when the matcher couldn't resolve
// it to ONE contact at ingest time — often because the contact didn't exist yet,
// or the message named someone by first name only. Nothing used to retry those
// rows, so the tray only ever grew and "zero customers" showed Slack mentions.
//
// This recurring job re-runs the (now smarter) shared matcher over every open
// row and auto-links the unambiguous ones, resolving the row. It is FREE — it
// reuses the AI extraction already stored on the row plus a deterministic
// email/phone scan of the original text; it never calls the AI again. Ambiguous
// rows stay in the tray for a human (§3 — never guess between two same-named
// people, never auto-create a contact).

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { maybeRaiseComplaintFromSlack } from './complaints'
import { extractContactSignals, extractNameCandidates } from './extract'
import {
  resolveSlackLinkTarget,
  resolveSlackLinkTargetFromNames,
  targetAuditTarget,
  targetForeignKey,
} from './link-target'
import { resolveSlackNames, resolveThreadParentText } from './names'
import { buildSlackPermalink } from './permalink'
import type { SlackEventEnvelope } from './types'

/** The slice of an `UnassignedSummary.parsed` blob the relink needs. */
export interface ParsedCandidate {
  name: string | null
  email: string | null
  phone: string | null
  summary: string | null
  category: string | null
  sentiment: string | null
  suggestedNextAction: string | null
  promptVersion: string | null
}

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v.trim() : null

/** Read the stored AI extraction off a parked row (defensive — the JSON shape
 *  is the slack-summary prompt output, but a row may predate a field). */
export function candidateFromParsed(parsed: unknown): ParsedCandidate {
  const p = (parsed ?? {}) as Record<string, unknown>
  const cand = (p['candidateContactIdentifier'] ?? {}) as Record<string, unknown>
  return {
    name: str(cand['name']),
    email: str(cand['email']),
    phone: str(cand['phone']),
    summary: str(p['summary']),
    category: str(p['category']),
    sentiment: str(p['sentiment']),
    suggestedNextAction: str(p['suggestedNextAction']),
    promptVersion: str(p['promptVersion']),
  }
}

/** How many open rows to scan per tick — bounded so a large backlog drains over
 *  a few ticks rather than in one long transaction. */
export const RELINK_BATCH = 200

/** Cap on thread-parent Slack API fetches per tick (conversations.replies is
 *  rate-limited). The rest of the backlog is retried on the next tick. */
export const RELINK_THREAD_FETCHES = 40

/** Cap on account-linked contacts scanned per tick for the retro-stamp pass.
 *  The junction is small relative to interactions; this bound is a safety net. */
export const RETRO_LINK_BUDGET = 5000

/**
 * A parked reply often names no customer of its own because its thread ROOT did
 * ("Sampada Neupane +447588744609"). The live ingestion now reads the parent,
 * but rows parked BEFORE that need it on retry. We recover the message's
 * `thread_ts` from the archived Slack ProviderEvent (no extra column), then
 * fetch the root's text. Best-effort: returns null on any miss so matching
 * falls back to the reply alone.
 */
async function threadParentTextForRow(row: {
  slackTs: string
  channelId: string
}): Promise<string | null> {
  const ev = await db.providerEvent.findFirst({
    where: { provider: 'slack', raw: { path: ['event', 'ts'], equals: row.slackTs } },
    select: { raw: true },
  })
  if (!ev) return null
  const envelope = ev.raw as unknown as SlackEventEnvelope
  const threadTs = envelope.event?.thread_ts
  if (!threadTs || threadTs === row.slackTs) return null
  return resolveThreadParentText({ channelId: row.channelId, threadTs })
}

/**
 * One pass over open parked rows: re-run the resolver and auto-link the
 * unambiguous ones. Shared by the recurring cron and the on-demand button.
 * `actorId` tags the audit row with which path triggered it.
 */
export async function relinkParkedRowsOnce(
  actorId: string,
): Promise<{ scanned: number; linked: number }> {
  const rows = await db.unassignedSummary.findMany({
    where: { resolvedAt: null },
    orderBy: { createdAt: 'asc' },
    take: RELINK_BATCH,
    select: {
      id: true,
      slackTs: true,
      channelId: true,
      parsed: true,
      confidence: true,
      messageText: true,
      senderName: true,
      createdAt: true,
    },
  })

  let linked = 0
  let threadBudget = RELINK_THREAD_FETCHES
  for (const row of rows) {
    const cand = candidateFromParsed(row.parsed)
    // Merge the stored AI candidate with a fresh deterministic scan of the
    // original message (catches an email/phone the first pass missed, and
    // costs nothing). extractContactSignals understands Slack's <tel:>/
    // <mailto:> markup as well as plain text.
    const fromText = extractContactSignals(row.messageText ?? '')
    const candidate = {
      name: cand.name,
      email: cand.email ?? fromText.email,
      phone: cand.phone ?? fromText.phone,
    }

    let target =
      candidate.name || candidate.email || candidate.phone
        ? await resolveSlackLinkTarget(candidate)
        : null

    // Deterministic NAME retry (free, DB-only): rows parked before name
    // extraction existed carry name:null and could never be rescued. Re-scan
    // the archived message text for name candidates and run them through the
    // same unambiguous-only resolver — so the historic backlog self-heals
    // without AI.
    if (!target && row.messageText) {
      const names = extractNameCandidates(row.messageText)
      if (names.length > 0) target = await resolveSlackLinkTargetFromNames(names)
    }

    // Thread-aware retry: a reply that named no customer inherits its thread
    // root's email/phone. Bounded per tick (Slack rate limits).
    if (!target && threadBudget > 0) {
      threadBudget -= 1
      const parentText = await threadParentTextForRow(row)
      if (parentText) {
        const parentSig = extractContactSignals(parentText)
        const withParent = {
          name: candidate.name,
          email: candidate.email ?? parentSig.email,
          phone: candidate.phone ?? parentSig.phone,
        }
        if (
          (withParent.email && withParent.email !== candidate.email) ||
          (withParent.phone && withParent.phone !== candidate.phone)
        ) {
          target = await resolveSlackLinkTarget(withParent)
        }
      }
    }

    if (!target) continue

    // Idempotent: a row may have been linked by a concurrent pass, or a
    // prior tick that failed after the interaction write. Dedupe on the
    // Slack ts already archived in a slack_summary payload.
    const existing = await db.interaction.findFirst({
      where: { type: 'slack_summary', payload: { path: ['slackTs'], equals: row.slackTs } },
      select: { id: true },
    })
    let interactionId = existing?.id ?? null
    if (!interactionId) {
      const created = await db.interaction.create({
        data: {
          id: createId(),
          type: 'slack_summary',
          ...targetForeignKey(target),
          occurredAt: row.createdAt,
          summary: (cand.summary ?? row.messageText ?? 'Slack message').slice(0, 280),
          payload: {
            event: 'slack.message_summarised',
            slackTs: row.slackTs,
            channelId: row.channelId,
            permalink: buildSlackPermalink(row.channelId, row.slackTs, null),
            messageText: row.messageText,
            senderName: row.senderName,
            category: cand.category ?? 'general',
            sentiment: cand.sentiment ?? 'neutral',
            suggestedNextAction: cand.suggestedNextAction,
            confidence: row.confidence,
            matchedVia: target.via,
            matchFuzzy: target.fuzzy ?? false,
            linkedTo: target.kind,
            autoRelinked: true,
            promptVersion: cand.promptVersion ?? 'relink-v1',
          },
        },
        select: { id: true },
      })
      interactionId = created.id
      await writeAuditLogEntry(db, {
        actorId,
        action: 'slack.message_summarised',
        target: targetAuditTarget(target),
        requestId: `slack-relink:${row.id}`,
        after: { interactionId, matchedVia: target.via, autoRelinked: true },
      })
    }

    // Channel-aware rule (ADR 0042): a complaint-channel mention that finally
    // linked to a contact also opens a Complaint. The occurredAt is the park
    // time, so the 7-day auto-raise horizon still applies — an old backlog row
    // linking months later doesn't reopen ancient history. Idempotent +
    // best-effort inside.
    if (target.contactId && row.messageText) {
      const { channelName } = await resolveSlackNames({ channelId: row.channelId })
      await maybeRaiseComplaintFromSlack({
        contactId: target.contactId,
        channelId: row.channelId,
        channelName,
        slackTs: row.slackTs,
        messageText: row.messageText,
        aiCategory: cand.category,
        occurredAt: row.createdAt,
      })
    }

    await db.unassignedSummary.update({
      where: { id: row.id },
      data: { resolvedAt: new Date() },
    })
    linked += 1
  }

  return { scanned: rows.length, linked }
}

/**
 * Retro-stamp: existing slack_summary mentions linked to a contact who belongs
 * to a B2B account (school / partnership) were written before §12 account-
 * stamping existed, so they never showed on the school's timeline. Walk the
 * (small) set of account-linked contacts and fill the blank `businessAccountId`
 * on their mentions. Idempotent (once stamped the row is excluded) and
 * self-healing as new BusinessAccountContact links appear.
 */
export async function retroStampSchoolMentionsOnce(): Promise<{
  contacts: number
  stamped: number
}> {
  const links = await db.businessAccountContact.findMany({
    select: { contactId: true, accountId: true },
    orderBy: { accountId: 'asc' },
    take: RETRO_LINK_BUDGET,
  })
  // One primary account per contact — lowest accountId, matching the live
  // resolver's deterministic choice.
  const primary = new Map<string, string>()
  for (const l of links) if (!primary.has(l.contactId)) primary.set(l.contactId, l.accountId)
  let stamped = 0
  for (const [contactId, accountId] of primary) {
    const res = await db.interaction.updateMany({
      where: {
        type: 'slack_summary',
        contactId,
        businessAccountId: null,
        deletedAt: null,
      },
      data: { businessAccountId: accountId },
    })
    stamped += res.count
  }
  return { contacts: primary.size, stamped }
}

export const slackRelinkUnassigned = inngest.createFunction(
  {
    id: 'slack/relink-unassigned',
    name: 'Auto-link parked Slack mentions to contacts',
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/30 * * * *' },
  async ({ step, logger }) => {
    const result = await step.run('relink', async () =>
      relinkParkedRowsOnce('system:slack/relink-unassigned'),
    )
    const retro = await step.run('retro-stamp-school-mentions', async () =>
      retroStampSchoolMentionsOnce(),
    )
    logger.info({ ...result, ...retro }, 'slack relink-unassigned complete')
    return { ...result, ...retro }
  },
)

/**
 * On-demand twin of the cron — fired by the "Re-run Slack matching now" button
 * (tRPC `slackSummary.unassigned.relinkNow`). Same two passes, immediately.
 */
export const slackRelinkNow = inngest.createFunction(
  {
    id: 'slack/relink-now',
    name: 'Re-run Slack matching on demand',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: 'slack/relink-now.requested' },
  async ({ event, step, logger }) => {
    const actorId =
      typeof (event.data as { actorId?: string })?.actorId === 'string'
        ? (event.data as { actorId: string }).actorId
        : 'system:slack/relink-now'
    const result = await step.run('relink', async () => relinkParkedRowsOnce(actorId))
    const retro = await step.run('retro-stamp-school-mentions', async () =>
      retroStampSchoolMentionsOnce(),
    )
    logger.info({ ...result, ...retro }, 'slack relink-now complete')
    return { ...result, ...retro }
  },
)
