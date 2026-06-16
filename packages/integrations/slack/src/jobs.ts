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

import { matchContactByCandidate } from './match'
import { extractContactSignals, slackTextToPlain } from './extract'
import { isIngestableSlackMessage } from './message-filter'
import { isSkippableSlackNoise } from './noise'
import { resolveSlackNames } from './names'
import { buildSlackPermalink } from './permalink'
import type { SlackEventEnvelope } from './types'

interface EventReceivedData {
  eventId: string
  providerEventRowId: string
  type: string
}

/** §12: only matches above this confidence become first-class Interactions. */
export const SLACK_MATCH_THRESHOLD = 0.7

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

    const occurredAt = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)

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

    // 1. Deterministic pre-match — cheapest route FIRST (§32; AI is the last
    //    resort). The team's call-log format carries the customer's phone or
    //    email verbatim, so a regex + the shared matcher resolves most
    //    mentions for free — and keeps the archive working when the AI
    //    provider is down, unconfigured, or over budget.
    const plainText = slackTextToPlain(message.text)
    const signals = extractContactSignals(message.text)
    if (signals.email || signals.phone) {
      const rulesMatch = await step.run('match-contact-rules', async () =>
        matchContactByCandidate(db, {
          name: null,
          email: signals.email,
          phone: signals.phone,
        }),
      )
      if (rulesMatch.contactId) {
        const contactId = rulesMatch.contactId
        const interaction = await step.run('upsert-interaction-rules', async () => {
          const existing = await db.interaction.findFirst({
            where: { payload: { path: ['slackEventId'], equals: eventId } },
            select: { id: true },
          })
          if (existing) return existing
          return db.interaction.create({
            data: {
              id: createId(),
              type: 'slack_summary',
              contactId,
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
                category: 'general',
                sentiment: 'neutral',
                suggestedNextAction: null,
                confidence: 1,
                matchedVia: rulesMatch.via,
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
            target: { type: 'Contact', id: contactId },
            requestId: eventId,
            after: { interactionId: interaction.id, matchedVia: rulesMatch.via, rules: true },
          })
        })
        await step.run('mark-processed', async () => {
          await db.providerEvent.update({
            where: { id: providerEventRowId },
            data: { processedAt: new Date() },
          })
        })
        return { ok: true, interactionId: interaction.id, matchedVia: 'rules' }
      }
    }

    // 2. AI parse (LAST — only when the free route found no unique contact).
    //    Sanitise the user content first (§18). An AI failure (no key, over
    //    budget, provider down) must never dead-letter the mention into
    //    nothing — it parks in the triage tray instead.
    const safeText = sanitiseUserContent(message.text)
    const prompt = buildSlackSummaryPrompt({
      channelName,
      authorDisplayName: senderName,
      text: safeText,
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
      parsed = {
        candidateContactIdentifier: {
          name: null,
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

    // 2. If confidence below threshold, park as UnassignedSummary and stop.
    if (parsed.confidence < SLACK_MATCH_THRESHOLD) {
      await step.run('park-unassigned', async () =>
        db.unassignedSummary.upsert({
          where: { slackTs_channelId: { slackTs: message.ts, channelId: message.channel } },
          create: {
            id: createId(),
            slackTs: message.ts,
            channelId: message.channel,
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
          },
        }),
      )
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { ok: true, parked: true, confidence: parsed.confidence }
    }

    // 3. High confidence — match to ONE contact: email, then phone
    //    (normalised variants), then an unambiguous full name. Ambiguity and
    //    misses park for triage; we never auto-create a Contact (§12) and
    //    never guess between two same-named people (§3).
    const match = await step.run('match-contact', async () =>
      matchContactByCandidate(db, parsed.candidateContactIdentifier),
    )
    const contactId = match.contactId

    if (!contactId) {
      // Confidence said yes but no match in our DB — also park.
      await step.run('park-no-match', async () =>
        db.unassignedSummary.upsert({
          where: { slackTs_channelId: { slackTs: message.ts, channelId: message.channel } },
          create: {
            id: createId(),
            slackTs: message.ts,
            channelId: message.channel,
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
      const existing = await db.interaction.findFirst({
        where: { payload: { path: ['slackEventId'], equals: eventId } },
        select: { id: true },
      })
      if (existing) return existing
      return db.interaction.create({
        data: {
          id: createId(),
          type: 'slack_summary',
          contactId,
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
            matchedVia: match.via,
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
        target: { type: 'Contact', id: contactId },
        requestId: eventId,
        after: {
          interactionId: interaction.id,
          confidence: parsed.confidence,
          promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
        },
      })
    })

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

export const FUNCTIONS = [
  slackEventReceived,
  aiDriftTriageReminder,
  ...SLACK_BACKFILL_FUNCTIONS,
] as const
