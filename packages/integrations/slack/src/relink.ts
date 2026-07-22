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
import { logger } from '@studymind/core/logger'
import { recordCronRun } from '@studymind/core/observability/cron-heartbeat'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { autoOnboardContactForSlackMessage } from './auto-onboard'
import { isCallLogChannel } from './channel-rules'
import { maybeRaiseComplaintFromSlack } from './complaints'
import { extractContactSignals, extractNameCandidates, slackTsToDate } from './extract'
import {
  resolveSlackLinkTarget,
  resolveSlackLinkTargetFromNames,
  targetAuditTarget,
  targetForeignKey,
} from './link-target'
import { resolveSlackNames, resolveThreadParentText } from './names'
import { isSkippableSlackNoise } from './noise'
import { isOwnBrandName, loadOwnBrands, type OwnBrands } from './own-brands'
import { buildSlackPermalink } from './permalink'
import type { SlackEventEnvelope } from './types'

/**
 * A parked row is UNRESCUABLE when there is genuinely nothing to match on and
 * never will be: no AI candidate name/email/phone, no name extractable from the
 * archived text (after own-brand filtering), no email/phone in the text, and the
 * text is either empty or pure Slack noise (an ack, an emoji, a bare link). A
 * human could not action such a row either, so the relink cron auto-dismisses it
 * (audited) to keep the tray a live worklist rather than an ever-growing
 * graveyard — the "smart dismiss" half of triage. A substantive but nameless
 * message (a real note that just doesn't name anyone the matcher can read) is
 * NOT unrescuable — it stays for a human to assign by hand (§3). Pure so it is
 * unit-tested in isolation.
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

/** Outcome of processing one parked row. */
type RelinkOutcome = 'linked' | 'dismissed' | 'parked'

/** AI confidence at/above which we trust its named customer enough to
 *  auto-create them from a parked mention in any channel (mirrors the live
 *  handler's SLACK_MATCH_THRESHOLD; kept local to avoid a jobs↔relink cycle). */
const AI_CONFIDENT_THRESHOLD = 0.5

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

/** Rows per batch. Kept modest so ONE batch is a short, self-contained unit of
 *  work that fits inside a single Inngest step (each batch is its own memoized
 *  step.run — the previous single-giant-step design blew the per-step execution
 *  budget on a real backlog and never committed). */
export const RELINK_BATCH = 100
/** Max batches (hence steps) per function invocation. batches × BATCH = rows
 *  drained per run; the recurring cron picks up any remainder next tick. */
export const RELINK_MAX_BATCHES = 25

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

export interface RelinkBatchResult {
  scanned: number
  linked: number
  dismissed: number
  errors: number
  /** Id of the last row examined — the keyset cursor for the next batch. */
  lastId: string | null
  /** True when this batch reached the end of the open backlog. */
  done: boolean
}

/**
 * Process ONE batch of open parked rows AFTER `afterId` (keyset paging on
 * `id asc`), re-running the resolver and auto-linking (or auto-dismissing) each.
 *
 * Keyset via an explicit `id > afterId` predicate (NOT Prisma cursor+skip) so
 * paging never breaks when the cursor row resolves and leaves the
 * `resolvedAt: null` set mid-drain. Each row is error-isolated — one poisoned
 * row must never abort the batch. Designed to be ONE Inngest step; the caller
 * loops batches across memoized steps so no single step exceeds the execution
 * budget (the previous whole-backlog-in-one-step design timed out).
 */
export async function relinkParkedRowsBatch(
  actorId: string,
  afterId: string | null,
): Promise<RelinkBatchResult> {
  // Own-brand catalogue is process-cached; load once per batch so the name
  // re-scan filters out "Medic Mind" & co exactly like the live ingest paths.
  const brands = await loadOwnBrands()
  const rows: RelinkRow[] = await db.unassignedSummary.findMany({
    where: { resolvedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) },
    orderBy: { id: 'asc' },
    take: RELINK_BATCH,
    select: {
      id: true,
      slackTs: true,
      channelId: true,
      channelName: true,
      parsed: true,
      confidence: true,
      messageText: true,
      senderName: true,
      createdAt: true,
    },
  })
  if (rows.length === 0) {
    return { scanned: 0, linked: 0, dismissed: 0, errors: 0, lastId: afterId, done: true }
  }

  let linked = 0
  let dismissed = 0
  let errors = 0
  let threadBudget = RELINK_THREAD_FETCHES
  for (const row of rows) {
    try {
      const outcome = await relinkOneRow(row, actorId, brands, () => {
        if (threadBudget <= 0) return false
        threadBudget -= 1
        return true
      })
      if (outcome === 'linked') linked += 1
      else if (outcome === 'dismissed') dismissed += 1
    } catch (err) {
      errors += 1
      logger.warn(
        { rowId: row.id, channelId: row.channelId, err },
        'slack relink: row failed — continuing with the rest',
      )
    }
  }
  return {
    scanned: rows.length,
    linked,
    dismissed,
    errors,
    lastId: rows[rows.length - 1]!.id,
    done: rows.length < RELINK_BATCH,
  }
}

interface RelinkRow {
  id: string
  slackTs: string
  channelId: string
  channelName: string | null
  parsed: unknown
  confidence: number | null
  messageText: string | null
  senderName: string | null
  createdAt: Date
}

/**
 * Try to resolve + archive ONE parked row. Returns:
 *   - 'linked'    → matched a contact/account and wrote the slack_summary
 *   - 'dismissed' → unrescuable (no identity, dead/noise text) → cleared
 *   - 'parked'    → still ambiguous / awaiting its contact → left for a human
 */
async function relinkOneRow(
  row: RelinkRow,
  actorId: string,
  brands: OwnBrands,
  takeThreadBudget: () => boolean,
): Promise<RelinkOutcome> {
  {
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
    // without AI. Own-brand tokens ("… Medic Mind") are filtered FIRST, exactly
    // as the live webhook + backfill do (jobs.ts / backfill.ts) — without this
    // the relink was the one path that let a brand name resolve as a second
    // entity and park an otherwise-linkable mention (the "Paula Baker" bug).
    const extractedNames = row.messageText
      ? extractNameCandidates(row.messageText).filter((n) => !isOwnBrandName(n, brands))
      : []
    if (!target && extractedNames.length > 0) {
      target = await resolveSlackLinkTargetFromNames(extractedNames)
    }

    // Thread-aware retry: a reply that named no customer inherits its thread
    // root's email/phone. Bounded per tick (Slack rate limits).
    if (!target && takeThreadBudget()) {
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

    // Auto-onboard (ADR 0043): a parked mention that STILL matches nobody
    // creates the customer — phone anchors, else email, else a full name — so
    // the tray backlog drains into real contact records instead of waiting
    // forever. Name-only creation unlocks in a call-log channel OR when the AI
    // was confident about the customer it named (operator direction 2026-07:
    // trust the AI's good guess). Shared lines stay parked (§41.1).
    // Prefer the channel name stored at park time; only resolve live when it is
    // absent, back-filling the row so the call-log-channel decision is
    // deterministic thereafter (a missing/rate-limited conversations.info scope
    // must not permanently block the name-only tier).
    let channelName = row.channelName ?? null
    if (channelName == null) {
      channelName = (await resolveSlackNames({ channelId: row.channelId })).channelName
      if (channelName) {
        await db.unassignedSummary.update({ where: { id: row.id }, data: { channelName } })
      }
    }
    const aiWasConfident = row.confidence != null && row.confidence >= AI_CONFIDENT_THRESHOLD
    if (!target && row.messageText) {
      target = await autoOnboardContactForSlackMessage({
        messageText: row.messageText,
        phone: candidate.phone ?? fromText.phone,
        email: candidate.email,
        nameCandidates: [...(candidate.name ? [candidate.name] : []), ...extractedNames],
        allowNameOnly: isCallLogChannel(channelName) || aiWasConfident,
        requestId: `slack-relink:${row.id}`,
      })
    }

    if (!target) {
      // Nothing linked. If the row is genuinely unrescuable (no identity + dead
      // or pure-noise text) auto-dismiss it so the tray reflects real work; a
      // substantive nameless message stays parked for a human (§3).
      if (
        isUnrescuableParkedRow({
          candidate,
          messageText: row.messageText,
          extractedNames,
          textSignals: { email: fromText.email, phone: fromText.phone },
        })
      ) {
        await db.unassignedSummary.update({
          where: { id: row.id },
          data: { resolvedAt: new Date() },
        })
        await writeAuditLogEntry(db, {
          actorId,
          action: 'slack_summary.dismissed',
          target: { type: 'UnassignedSummary', id: row.id },
          requestId: `slack-relink:${row.id}`,
          after: { auto: true, reason: 'unrescuable', channelId: row.channelId },
        })
        return 'dismissed'
      }
      return 'parked'
    }

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
    // linked to a contact also opens a Complaint. occurredAt is the MESSAGE
    // time (slackTs), not the park time — a backfill parks old messages with a
    // fresh createdAt, and the 7-day auto-raise horizon must judge when the
    // customer actually complained, not when the row was parked. Idempotent +
    // best-effort inside; channel-name lookups are cached per channel.
    if (target.contactId && row.messageText) {
      await maybeRaiseComplaintFromSlack({
        contactId: target.contactId,
        channelId: row.channelId,
        channelName,
        slackTs: row.slackTs,
        messageText: row.messageText,
        aiCategory: cand.category,
        occurredAt: slackTsToDate(row.slackTs),
      })
    }

    await db.unassignedSummary.update({
      where: { id: row.id },
      data: { resolvedAt: new Date() },
    })
    return 'linked'
  }
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
  { cron: '*/15 * * * *' },
  async ({ step, logger }) => {
    // Drain across many SHORT, memoized steps (one 100-row batch per step), so
    // no single step exceeds Inngest's execution budget (the whole-backlog-in-
    // one-step design timed out and never committed). Keyset paging continues
    // after the previous batch's lastId, so linked/dismissed rows leaving the
    // open set never break paging.
    let afterId: string | null = null
    const result = { scanned: 0, linked: 0, dismissed: 0, errors: 0, batches: 0 }
    for (let i = 0; i < RELINK_MAX_BATCHES; i += 1) {
      const cursor = afterId
      const batch: RelinkBatchResult = await step.run(`relink-batch-${i}`, async () =>
        relinkParkedRowsBatch('system:slack/relink-unassigned', cursor),
      )
      result.scanned += batch.scanned
      result.linked += batch.linked
      result.dismissed += batch.dismissed
      result.errors += batch.errors
      result.batches += 1
      if (batch.done) break
      afterId = batch.lastId
    }
    const retro = await step.run('retro-stamp-school-mentions', async () =>
      retroStampSchoolMentionsOnce(),
    )
    await step.run('heartbeat', async () =>
      recordCronRun(db, { functionId: 'slack/relink-unassigned', success: true, durationMs: 0 }),
    )
    logger.info({ ...result, ...retro }, 'slack relink-unassigned complete')
    return { ...result, ...retro }
  },
)

/**
 * On-demand twin of the cron — fired by the "Re-run Slack matching now" button
 * (tRPC `slackSummary.unassigned.relinkNow`). Same paged drain, immediately.
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
    let afterId: string | null = null
    const result = { scanned: 0, linked: 0, dismissed: 0, errors: 0, batches: 0 }
    for (let i = 0; i < RELINK_MAX_BATCHES; i += 1) {
      const cursor = afterId
      const batch: RelinkBatchResult = await step.run(`relink-batch-${i}`, async () =>
        relinkParkedRowsBatch(actorId, cursor),
      )
      result.scanned += batch.scanned
      result.linked += batch.linked
      result.dismissed += batch.dismissed
      result.errors += batch.errors
      result.batches += 1
      if (batch.done) break
      afterId = batch.lastId
    }
    const retro = await step.run('retro-stamp-school-mentions', async () =>
      retroStampSchoolMentionsOnce(),
    )
    logger.info({ ...result, ...retro }, 'slack relink-now complete')
    return { ...result, ...retro }
  },
)
