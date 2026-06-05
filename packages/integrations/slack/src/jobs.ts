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

    // Only message.channels with a text body — bots, joins, and edits are
    // ignored at this layer (they may be re-enabled per channel later).
    if (message.type !== 'message' || !message.text || message.subtype) {
      logger.info({ eventId, subtype: message.subtype }, 'slack event not a usable message')
      await step.run('mark-processed', async () => {
        await db.providerEvent.update({
          where: { id: providerEventRowId },
          data: { processedAt: new Date() },
        })
      })
      return { skipped: true, reason: 'not_a_message' }
    }

    const occurredAt = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)

    // 1. AI parse. Sanitise the user content first (§18).
    const safeText = sanitiseUserContent(message.text)
    const prompt = buildSlackSummaryPrompt({
      channelName: null,
      authorDisplayName: message.user ?? null,
      text: safeText,
    })
    const parsed: SlackSummary = await step.run('ai-parse', async () =>
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
          },
          update: {
            parsed: parsed as unknown as object,
            confidence: parsed.confidence,
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

    // 3. High confidence — match to a Contact (email then phone). Never
    //    auto-create a Contact (§12).
    const contactId = await step.run('match-contact', async () =>
      matchContactByCandidate(parsed),
    )

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
          },
          update: {
            parsed: parsed as unknown as object,
            confidence: parsed.confidence,
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
            channelName: null,
            // Archive the ORIGINAL message text + author so the full internal
            // record survives Slack's 90-day retention (§21). The view-model
            // (contact-channels SlackMention) already surfaces these fields.
            messageText: message.text,
            senderName: message.user ?? null,
            // AI categorisation so the archived record is sortable.
            category: parsed.category,
            sentiment: parsed.sentiment,
            suggestedNextAction: parsed.suggestedNextAction,
            confidence: parsed.confidence,
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

async function matchContactByCandidate(parsed: SlackSummary): Promise<string | null> {
  const email = parsed.candidateContactIdentifier.email?.trim().toLowerCase() ?? null
  const phone = parsed.candidateContactIdentifier.phone?.trim() ?? null

  if (email) {
    const byEmail = await db.contact.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    })
    if (byEmail) return byEmail.id
  }
  if (phone && phone.startsWith('+')) {
    const byPhone = await db.contact.findFirst({
      where: { phoneE164: phone, deletedAt: null },
      select: { id: true },
    })
    if (byPhone) return byPhone.id
  }
  return null
}

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
