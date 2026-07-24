// Slack Inngest functions. CLAUDE.md §12, §17, §18.
//
// slackEventReceived listens for `slack/event.received` (enqueued by the
// route handler after signature verification). It runs the slack-summary AI
// prompt against the message body and either:
//   - confidence >= 0.7: matches the candidate to a Contact (email then
//     phone) and writes a slack_summary Interaction.
//   - confidence  < 0.7: writes the parsed result to UnassignedSummary for
//     an agent to triage. We never auto-create a Contact.
//
// AI-heavy, so concurrency is capped at 3 per §17.

import { createId } from '@paralleldrive/cuid2'

import {
  buildSlackSummaryPrompt,
  runStructured,
  sanitiseUserContent,
  slackSummarySchema,
  SLACK_SUMMARY_PROMPT_VERSION,
  type SlackSummary,
} from '@studymind/ai'
import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { autoOnboardContactForSlackMessage } from './auto-onboard'
import { isCallLogChannel, isComplaintChannel } from './channel-rules'
import { maybeRaiseComplaintFromSlack } from './complaints'
import { parseCallLogClient } from './complaint-parse'
import { isOwnBrandEmail, isOwnBrandName, loadOwnBrands } from './own-brands'
import {
  resolveSlackLinkTarget,
  resolveSlackLinkTargetFromNames,
  targetAuditTarget,
  targetForeignKey,
} from './link-target'
import {
  extractContactSignals,
  extractNameCandidates,
  slackTextToPlain,
  slackTsToDate,
} from './extract'
import { isIngestableSlackMessage } from './message-filter'
import { isSkippableSlackNoise } from './noise'
import { resolveSlackNames, resolveThreadParentText } from './names'
import { buildSlackPermalink } from './permalink'
import type { SlackEventEnvelope } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

/** §12: the AI must be at least this confident in its extraction before we try
 *  to match it live. The real safety is the matcher's unambiguous-only rule
 *  (§3), so we keep this modest — anything that still parks is retried for free
 *  by the `slack/relink-unassigned` job, which auto-links it once it resolves to
 *  exactly one contact. */
export const SLACK_MATCH_THRESHOLD = 0.5

export const slackEventReceived = inngest.createFunction(
  {
    id: 'slack/event.received',
    name: 'Process a Slack event from ProviderEvent',
    concurrency: { limit: 3 },
    retries: 6,
  },
  { event: 'slack/event.received' },
  async ({ event, step, logger }) => {
    const data = event.data as EventReceivedData
    const { eventId, providerEventRowId } = data

    const providerEvent = await step.run('load-event', async () => {
      const row = await db.providerEvent.findUniqueOrThrow({
        where: { id: providerEventRowId },
        select: { raw: true },
      })
      return row
    })
    const envelope = providerEvent.raw as unknown as SlackEventEnvelope
    const message = envelope.event

    // Only human-authored message.channels with text are ingested. Joins,
    // edits, and crucially any BOT/APP post (incl. the CRM's own compulsory
    // call-summary announcements, ADR 0039) are skipped here so we never
    // re-ingest our own post as a duplicate slack_summary (§3).
    if (!isIngestableSlackMessage(message)) {
      logger.info(
        { eventId, subtype: message.subtype, botId: message.bot_id },
        'slack event not an ingestable human message',
      )
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'not_ingestable' }
    }

    // Free pre-filter (§32): acks, reactions, emoji and bare links never
    // reference a customer — skip them before any AI spend or API call.
    if (isSkippableSlackNoise(message.text)) {
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'noise' }
    }

    const occurredAt = slackTsToDate(message.ts)

    // 0. Resolve the human-readable details the Events payload doesn't carry:
    //    sender display name (users.info), channel #name (conversations.info)
    //    and a permalink (constructed — the payload has none). Each is
    //    best-effort: a missing scope or token keeps the raw ids, never
    //    blocks the archive.
    const resolved = await step.run('resolve-details', async () =>
      resolveSlackNames({ userId: message.user ?? null, channelId: message.channel }),
    )
    const senderName = resolved.senderName ?? message.user ?? null
    const channelName = resolved.channelName
    const permalink = buildSlackPermalink(message.channel, message.ts, message.thread_ts ?? null)

    // A threaded REPLY frequently names no customer of its own ("£40 premium
    // hour paid 15/06") because the thread ROOT already did ("Sampada Neupane
    // +447588744609"). Pull the root once so the reply inherits its customer —
    // both for the free email/phone match and as context for the AI. Best-effort
    // (ADR 0034 amendment); a missing token/scope just falls back to the reply.
    const threadTs =
      message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : null
    const threadParentText = threadTs
      ? await step.run('resolve-thread-parent', async () =>
          resolveThreadParentText({ channelId: message.channel, threadTs }),
        )
      : null

    // 1. Deterministic pre-match — cheapest route FIRST (§32; AI is the last
    //    resort). The team's call-log format carries the customer's phone or
    //    email verbatim, so a regex + the shared matcher resolves most
    //    mentions for free — and keeps the archive working when the AI
    //    provider is down, unconfigured, or over budget. The thread root is
    //    checked too, so a reply inherits the customer named upthread.
    const plainText = slackTextToPlain(message.text)
    // Own-brand tokens ("Medic Mind" trailing every summary, info@… emails)
    // are filtered out of the candidates so they can never hijack a match
    // (ADR 0043). Not a step: the result carries a Set (not JSON-safe) and the
    // loader is process-cached anyway.
    const brands = await loadOwnBrands()
    const signals = extractContactSignals(message.text)
    const parentSignals = threadParentText
      ? extractContactSignals(threadParentText)
      : { email: null, phone: null }
    // Smart-assign the labelled call-log / call-summary format: prefer the
    // explicit CLIENT identity over the first email/phone in the text (which can
    // be the guardian). Null for non-labelled messages → no change.
    const structured = parseCallLogClient(message.text ?? '')
    const usableEmail = (e: string | null) => (e && !isOwnBrandEmail(e, brands) ? e : null)
    const matchEmail =
      usableEmail(structured?.clientEmail ?? null) ??
      usableEmail(signals.email) ??
      usableEmail(parentSignals.email)
    const matchPhone = structured?.clientPhone ?? signals.phone ?? parentSignals.phone
    let rulesTarget =
      matchEmail || matchPhone
        ? await step.run('match-target-rules', async () =>
            resolveSlackLinkTarget({ name: null, email: matchEmail, phone: matchPhone }),
          )
        : null

    // Free NAME pass (still no AI): the deterministic path used to hard-code
    // name:null, so a name-only mention could only ever link through the AI —
    // and never linked at all when no provider key was configured. The
    // unambiguous-only matcher (take:2, §3) is the safety: a non-name token
    // matches nobody, two same-named contacts park for a human.
    const nameCandidates = extractNameCandidates(message.text).filter(
      (n) => !isOwnBrandName(n, brands),
    )
    const parentNameCandidates = (
      threadParentText ? extractNameCandidates(threadParentText) : []
    ).filter((n) => !isOwnBrandName(n, brands))
    if (!rulesTarget && (nameCandidates.length > 0 || parentNameCandidates.length > 0)) {
      rulesTarget = await step.run('match-target-names', async () => {
        const own = await resolveSlackLinkTargetFromNames(nameCandidates)
        if (own) return own
        return parentNameCandidates.length > 0
          ? resolveSlackLinkTargetFromNames(parentNameCandidates)
          : null
      })
    }

    // Auto-onboard (ADR 0043): a call log that matched nobody creates the
    // customer — phone anchors, else email, else (call-log channels only) a
    // full name. Only the MESSAGE's own identity counts; shared lines return
    // null and park (§41.1).
    if (!rulesTarget) {
      rulesTarget = await step.run('auto-onboard', async () =>
        autoOnboardContactForSlackMessage({
          messageText: message.text,
          phone: signals.phone,
          email: usableEmail(signals.email),
          nameCandidates,
          allowNameOnly: isCallLogChannel(channelName),
          requestId: eventId,
        }),
      )
    }
    if (rulesTarget) {
      const target = rulesTarget
      const interaction = await step.run('upsert-interaction-rules', async () => {
        const existing = await db.interaction.findFirst({
          where: {
            type: 'slack_summary',
            // Match this event id OR the (slackTs, channelId) key the pull /
            // backfill write (they set no slackEventId) — so a message the pull
            // ingested first isn't re-created as a duplicate by the webhook.
            OR: [
              { payload: { path: ['slackEventId'], equals: eventId } },
              {
                AND: [
                  { payload: { path: ['slackTs'], equals: message.ts } },
                  { payload: { path: ['channelId'], equals: message.channel } },
                ],
              },
            ],
          },
          select: { id: true },
        })
        if (existing) return existing
        return db.interaction.create({
          data: {
            id: createId(),
            type: 'slack_summary',
            ...targetForeignKey(target),
            occurredAt,
            summary: plainText.slice(0, 280),
            payload: {
              event: 'slack.message_summarised',
              slackEventId: eventId,
              slackTs: message.ts,
              channelId: message.channel,
              channelName,
              permalink,
              ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
              messageText: message.text,
              senderName,
              category: isComplaintChannel(channelName) ? 'complaint' : 'general',
              sentiment: 'neutral',
              suggestedNextAction: null,
              confidence: 1,
              matchedVia: target.via,
              matchFuzzy: target.fuzzy ?? false,
              linkedTo: target.kind,
              promptVersion: 'rules-v1',
            },
          },
          select: { id: true },
        })
      })
      await step.run('audit-rules', async () => {
        await writeAuditLogEntry(db, {
          actorId: null,
          action: 'slack.message_summarised',
          target: targetAuditTarget(target),
          requestId: eventId,
          after: { interactionId: interaction.id, matchedVia: target.via, rules: true },
        })
      })
      // Channel-aware rule (ADR 0042): a complaint-channel call summary that
      // linked to a contact also opens a Complaint. Idempotent + best-effort.
      await step.run('auto-complaint-rules', async () =>
        maybeRaiseComplaintFromSlack({
          contactId: target.contactId ?? null,
          channelId: message.channel,
          channelName,
          slackTs: message.ts,
          messageText: message.text,
          aiCategory: null,
          occurredAt,
          // `threadTs` is non-null only for a reply — only the thread's starting
          // message opens a complaint (replies are the follow-up).
          isThreadReply: threadTs !== null,
        }),
      )
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { ok: true, interactionId: interaction.id, matchedVia: 'rules' }
    }

    // 2. AI parse (LAST — only when the free route found no unique contact).
    //    Sanitise the user content first (§18). An AI failure (no key, over
    //    budget, provider down) must never dead-letter the mention into
    //    nothing — it parks in the triage tray instead.
    const safeText = sanitiseUserContent(message.text)
    // Give the AI the thread root as context so a reply ("paid £40…") resolves
    // to the customer named upthread, not "no identifier found".
    const aiText = threadParentText
      ? `[Earlier in this thread] ${sanitiseUserContent(threadParentText)}\n\n[This message] ${safeText}`
      : safeText
    const prompt = buildSlackSummaryPrompt({
      channelName,
      authorDisplayName: senderName,
      text: aiText,
    })
    let parsed: SlackSummary
    try {
      parsed = await step.run('ai-parse', async () =>
        runStructured({
          task: 'slack_summary',
          promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
          schema: slackSummarySchema,
          schemaName: 'slack_summary',
          system: prompt.system,
          user: prompt.user,
          ctx: { eventId, channelId: message.channel },
        }),
      )
    } catch (err) {
      logger.warn({ eventId, err }, 'slack ai-parse failed — parking for human triage')
      // The deterministic name candidate rides along so the relink cron can
      // resolve this row by name once the contact exists (a null name made
      // the parked row un-rescuable).
      parsed = {
        candidateContactIdentifier: {
          name: nameCandidates[0] ?? parentNameCandidates[0] ?? null,
          email: signals.email,
          phone: signals.phone,
        },
        summary: plainText.slice(0, 600) || 'Slack message',
        category: 'general',
        sentiment: 'neutral',
        suggestedNextAction: null,
        confidence: 0,
      }
    }

    // 2. Match to ONE contact (email → phone → unambiguous name), else ONE
    //    B2B account, else onboard from the message's identity under the ADR
    //    0043 tiers. AI confidence is NOT a gate: the matcher's unambiguous
    //    rule is the real safety (ADR 0034), and onboarding reads the message's
    //    OWN phone/email/name, which a low AI confidence has no bearing on.
    //    Gating on confidence used to park a low-confidence message carrying a
    //    clear phone/name — the audit's parked-backlog root cause. Only true
    //    dead-ends (no identity at all) park.
    const target = await step.run('match-target', async () => {
      const resolvedTarget = await resolveSlackLinkTarget(parsed.candidateContactIdentifier)
      if (resolvedTarget) return resolvedTarget
      return autoOnboardContactForSlackMessage({
        messageText: message.text,
        phone: parsed.candidateContactIdentifier.phone ?? signals.phone,
        email: usableEmail(parsed.candidateContactIdentifier.email ?? signals.email),
        nameCandidates: [
          ...(parsed.candidateContactIdentifier.name
            ? [parsed.candidateContactIdentifier.name]
            : []),
          ...nameCandidates,
        ],
        // The AI already cleared the confidence bar (§3 amendment, operator
        // direction 2026-07): trust its good guess to create the customer if
        // they don't exist yet, in ANY channel — not just call-log channels.
        // Own-brand + noise + full-name guards still apply inside onboard.
        allowNameOnly: true,
        requestId: eventId,
      })
    })

    if (!target) {
      // No identity keyed and nothing to onboard on — park; the relink cron
      // keeps retrying, and channelName is stored so its call-log decision is
      // deterministic without a live conversations.info call.
      await step.run('park-no-match', async () =>
        db.unassignedSummary.upsert({
          where: { slackTs_channelId: { slackTs: message.ts, channelId: message.channel } },
          create: {
            id: createId(),
            slackTs: message.ts,
            channelId: message.channel,
            channelName,
            parsed: parsed as unknown as object,
            confidence: parsed.confidence,
            messageText: message.text,
            senderName,
          },
          update: {
            parsed: parsed as unknown as object,
            confidence: parsed.confidence,
            messageText: message.text,
            senderName,
            ...(channelName ? { channelName } : {}),
          },
        }),
      )
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { ok: true, parked: true, reason: 'no_contact_match' }
    }

    // 4. Write the slack_summary Interaction (idempotent on event_id).
    const interaction = await step.run('upsert-interaction', async () => {
      // Dedup on the webhook event id OR the (slackTs, channelId) pair — the
      // pull/backfill/relink paths key on the latter (they have no webhook
      // eventId), so checking slackEventId alone let a message ingested by one
      // path be re-created as a duplicate slack_summary by another.
      const existing = await db.interaction.findFirst({
        where: {
          type: 'slack_summary',
          OR: [
            { payload: { path: ['slackEventId'], equals: eventId } },
            {
              AND: [
                { payload: { path: ['slackTs'], equals: message.ts } },
                { payload: { path: ['channelId'], equals: message.channel } },
              ],
            },
          ],
        },
        select: { id: true },
      })
      if (existing) return existing
      return db.interaction.create({
        data: {
          id: createId(),
          type: 'slack_summary',
          ...targetForeignKey(target),
          occurredAt,
          summary: parsed.summary.slice(0, 280),
          payload: {
            event: 'slack.message_summarised',
            slackEventId: eventId,
            slackTs: message.ts,
            channelId: message.channel,
            channelName,
            permalink,
            ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
            // Archive the ORIGINAL message text + author so the full internal
            // record survives Slack's 90-day retention (§21). The view-model
            // (contact-channels SlackMention) already surfaces these fields.
            messageText: message.text,
            senderName,
            // AI categorisation so the archived record is sortable.
            category: parsed.category,
            sentiment: parsed.sentiment,
            suggestedNextAction: parsed.suggestedNextAction,
            confidence: parsed.confidence,
            matchedVia: target.via,
            matchFuzzy: target.fuzzy ?? false,
            linkedTo: target.kind,
            promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
          },
        },
        select: { id: true },
      })
    })

    await step.run('audit', async () => {
      await writeAuditLogEntry(db, {
        actorId: null,
        action: 'slack.message_summarised',
        target: targetAuditTarget(target),
        requestId: eventId,
        after: {
          interactionId: interaction.id,
          confidence: parsed.confidence,
          promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
        },
      })
    })

    await step.run('auto-complaint', async () =>
      maybeRaiseComplaintFromSlack({
        contactId: target.contactId ?? null,
        channelId: message.channel,
        channelName,
        slackTs: message.ts,
        messageText: message.text,
        aiCategory: parsed.category,
        occurredAt,
        // `threadTs` is non-null only for a reply — only the thread's starting
        // message opens a complaint (replies are the follow-up).
        isThreadReply: threadTs !== null,
      }),
    )

    await step.run('mark-processed', async () => {
      await db.providerEvent.update({
        where: { id: providerEventRowId },
        data: { processedAt: new Date() },
      })
    })

    return { ok: true, interactionId: interaction.id }
  },
)

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// Weekly drift-triage reminder. CLAUDE.md §18.3.
// Counts untriaged DriftSample rows and posts a reminder to #crm-finops.
export const aiDriftTriageReminder = inngest.createFunction(
  {
    id: 'ai/drift-triage-reminder',
    name: 'AI: weekly drift-sample triage reminder',
    concurrency: { limit: 1 },
    retries: 1,
  },
  // Mondays at 09:00 UTC.
  { cron: '0 9 * * 1' },
  async ({ step, logger }) => {
    const channelId = process.env['SLACK_FINOPS_CHANNEL_ID']
    if (!channelId) {
      logger.warn('SLACK_FINOPS_CHANNEL_ID not set; skipping drift triage reminder')
      return { skipped: true }
    }

    const untriaged = await step.run('count-untriaged', async () => {
      return db.driftSample.count({ where: { reviewed: false } })
    })

    if (untriaged === 0) {
      logger.info('drift triage: zero untriaged samples')
      return { untriaged: 0, posted: false }
    }

    const weekKey = new Date().toISOString().slice(0, 10)
    await step.run('post-alert', async () => {
      const { postAlert } = await import('./outbound')
      await postAlert({
        message: `Drift triage: ${untriaged} AI samples await review.`,
        idempotencyKey: `drift-triage:${weekKey}`,
        channelId,
        ctx: { actorId: 'system', requestId: `drift-triage:${weekKey}` },
      })
    })
    return { untriaged, posted: true }
  },
)

// ADR 0017: 90-day historic backfill on first-connect.
import { BACKFILL_FUNCTIONS as SLACK_BACKFILL_FUNCTIONS } from './backfill'
// ADR 0042 amendment: retroactively open complaints for existing complaint-
// channel mentions (admin button).
import { COMPLAINT_BACKFILL_FUNCTIONS } from './backfill-complaints'
// ADR 0034 amendment: recurring auto-relink of parked mentions + its on-demand
// twin (the "Re-run Slack matching now" button).
import { slackRelinkNow, slackRelinkUnassigned } from './relink'
// Recurring + on-demand PULL of messages from every bot channel (robust
// ingestion independent of the Events webhook).
import { SYNC_FUNCTIONS as SLACK_SYNC_FUNCTIONS } from './sync'

export const FUNCTIONS = [
  slackEventReceived,
  aiDriftTriageReminder,
  slackRelinkUnassigned,
  slackRelinkNow,
  ...SLACK_SYNC_FUNCTIONS,
  ...SLACK_BACKFILL_FUNCTIONS,
  ...COMPLAINT_BACKFILL_FUNCTIONS,
] as const
