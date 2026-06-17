// Slack 90-day historic backfill worker (ADR 0017).
//
// Walks each watched channel via `conversations.history?oldest=<unix>` and
// runs the existing slack-summary AI prompt against each message. Persists
// a `slack_summary` Interaction when confidence >= 0.7 AND the parsed
// candidate matches a CRM Contact by email/phone. We do NOT create
// UnassignedSummary rows during backfill — too noisy per the brief.
//
// AI-heavy: concurrency capped at 3 to respect rate limits (§17).

import { createId } from '@paralleldrive/cuid2'

import {
  buildSlackSummaryPrompt,
  runStructured,
  sanitiseUserContent,
  slackSummarySchema,
  SLACK_SUMMARY_PROMPT_VERSION,
  type SlackSummary,
} from '@studymind/ai'
import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import { safeFetch } from '@studymind/core/observability/safe-fetch'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { SLACK_API_BASE } from './client'
import { getWatchedChannels } from './config'
import { matchContactByCandidate } from './match'
import { extractContactSignals, slackTextToPlain } from './extract'
import { isSkippableSlackNoise } from './noise'
import { resolveSlackNames } from './names'

interface BackfillRequestedData {
  jobId: string
  provider: 'slack'
  agentId: string | null
  windowFrom: string
  windowTo: string
}

interface SlackHistoryMessage {
  type?: string
  subtype?: string
  ts: string
  user?: string
  text?: string
  permalink?: string
}

interface SlackHistoryResponse {
  ok: boolean
  error?: string
  messages?: SlackHistoryMessage[]
  has_more?: boolean
  response_metadata?: { next_cursor?: string }
}

// Matches the live ingestion gate (ADR 0034 amendment) — the matcher's
// unambiguous rule is the real safety, not the AI's self-confidence.
const MATCH_THRESHOLD = 0.5

export const slackBackfillRequested = inngest.createFunction(
  {
    id: 'slack/backfill.requested',
    name: 'Backfill last 90 days of Slack messages from watched channels',
    concurrency: { limit: 3 },
    retries: 3,
  },
  { event: 'backfill/slack.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId, windowFrom } = data
    const token = process.env['SLACK_BOT_TOKEN']
    if (!token) {
      await markBackfillFailed(db, jobId, 'SLACK_BOT_TOKEN not configured', jobId)
      return { skipped: true, reason: 'no_token' }
    }

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    const oldest = Math.floor(new Date(windowFrom).getTime() / 1000)
    const channels = getWatchedChannels()

    try {
      for (const channelId of channels) {
        let cursor: string | undefined
        let pageNum = 0
        do {
          const res = await step.run(`history-${channelId}-${pageNum}`, async () =>
            fetchHistory(token, channelId, oldest, cursor),
          )
          for (const m of res.messages ?? []) {
            try {
              const result = await step.run(`msg-${channelId}-${m.ts}`, async () =>
                processSlackMessage({ message: m, channelId, requestId: jobId }),
              )
              processed += 1
              if (result.matched) matched += 1
              else skipped += 1
            } catch (err) {
              // One message that fails AI parsing/persist must not abort the
              // whole channel import. Skip it and keep going.
              processed += 1
              skipped += 1
              logger.warn(
                { jobId, channelId, ts: m.ts, err },
                'slack backfill: skipped a message that failed to import',
              )
            }
          }
          await step.run(`progress-${channelId}-${pageNum}`, async () =>
            incrementBackfillProgress(db, jobId, {
              processed,
              matched,
              skipped,
              lastEventId: res.messages?.[res.messages.length - 1]?.ts ?? null,
            }),
          )
          cursor = res.has_more ? res.response_metadata?.next_cursor : undefined
          pageNum += 1
        } while (cursor)
      }

      await step.run('mark-completed', async () =>
        markBackfillCompleted(db, jobId, {
          processed,
          matched,
          skipped,
          totalCount: processed,
          requestId: jobId,
        }),
      )
      return { ok: true, processed, matched, skipped }
    } catch (err) {
      logger.error({ jobId, err }, 'slack backfill failed')
      await markBackfillFailed(
        db,
        jobId,
        err instanceof Error ? err.message : 'unknown error',
        jobId,
      )
      throw err
    }
  },
)

async function fetchHistory(
  token: string,
  channelId: string,
  oldest: number,
  cursor: string | undefined,
): Promise<SlackHistoryResponse> {
  const params = new URLSearchParams({
    channel: channelId,
    oldest: String(oldest),
    limit: '100',
  })
  if (cursor) params.set('cursor', cursor)
  const res = await safeFetch(`${SLACK_API_BASE}/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  const parsed = (text ? JSON.parse(text) : {}) as SlackHistoryResponse
  if (!parsed.ok) {
    throw new Error(`slack conversations.history error: ${parsed.error}`)
  }
  return parsed
}

interface ProcessSlackInput {
  message: SlackHistoryMessage
  channelId: string
  requestId: string
}

async function processSlackMessage(input: ProcessSlackInput): Promise<{ matched: boolean }> {
  const { message, channelId } = input
  if (message.type !== 'message' || !message.text || message.subtype) {
    return { matched: false }
  }

  // Idempotent on (channelId, ts).
  const existing = await db.interaction.findFirst({
    where: {
      type: 'slack_summary',
      AND: [
        { payload: { path: ['slackTs'], equals: message.ts } },
        { payload: { path: ['channelId'], equals: channelId } },
      ],
    },
    select: { id: true },
  })
  if (existing) return { matched: true }

  // Free pre-filter (§32) — no AI spend on chatter that can't name a customer.
  if (isSkippableSlackNoise(message.text)) return { matched: false }

  const { senderName: resolvedSender, channelName } = await resolveSlackNames({
    userId: message.user ?? null,
    channelId,
  })
  const senderName = resolvedSender ?? message.user ?? null

  // Deterministic pre-match FIRST (cheapest route; AI last — §32). The
  // call-log format carries the customer's phone/email verbatim, so the
  // backfill archives those mentions with zero AI spend — and still works
  // when no AI provider is configured at all.
  const signals = extractContactSignals(message.text)
  if (signals.email || signals.phone) {
    const rulesMatch = await matchContactByCandidate(db, {
      name: null,
      email: signals.email,
      phone: signals.phone,
    })
    if (rulesMatch.contactId) {
      const occurredAtRules = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)
      await db.interaction.create({
        data: {
          id: createId(),
          type: 'slack_summary',
          contactId: rulesMatch.contactId,
          occurredAt: occurredAtRules,
          summary: slackTextToPlain(message.text).slice(0, 280),
          payload: {
            backfill: true,
            event: 'slack.message_summarised',
            slackTs: message.ts,
            channelId,
            channelName,
            permalink: message.permalink ?? null,
            messageText: message.text ?? null,
            senderName,
            category: 'general',
            sentiment: 'neutral',
            suggestedNextAction: null,
            confidence: 1,
            matchedVia: rulesMatch.via,
            promptVersion: 'rules-v1',
          },
        },
      })
      return { matched: true }
    }
  }

  const safeText = sanitiseUserContent(message.text)
  const prompt = buildSlackSummaryPrompt({
    channelName,
    authorDisplayName: senderName,
    text: safeText,
  })
  // AI is best-effort in the backfill: no provider key / budget exhaustion
  // must not abort the whole history walk — the deterministic pass above has
  // already archived everything it could.
  let parsed: SlackSummary
  try {
    parsed = await runStructured({
      task: 'slack_summary',
      promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
      schema: slackSummarySchema,
      schemaName: 'slack_summary',
      system: prompt.system,
      user: prompt.user,
      ctx: { channelId, slackTs: message.ts, backfill: true },
    })
  } catch {
    return { matched: false }
  }

  if (parsed.confidence < MATCH_THRESHOLD) return { matched: false }

  // Shared matcher: email → phone variants → unambiguous full name (§12).
  const match = await matchContactByCandidate(db, parsed.candidateContactIdentifier)
  const contactId = match.contactId
  if (!contactId) return { matched: false }

  const occurredAt = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'slack_summary',
      contactId,
      occurredAt,
      summary: parsed.summary.slice(0, 280),
      payload: {
        backfill: true,
        event: 'slack.message_summarised',
        slackTs: message.ts,
        channelId,
        channelName,
        permalink: message.permalink ?? null,
        // Archive the original message + author so the record outlives Slack's
        // 90-day window (ADR 0034). Category sorts the record.
        messageText: message.text ?? null,
        senderName,
        category: parsed.category,
        sentiment: parsed.sentiment,
        suggestedNextAction: parsed.suggestedNextAction,
        confidence: parsed.confidence,
        matchedVia: match.via,
        promptVersion: SLACK_SUMMARY_PROMPT_VERSION,
      },
    },
  })
  return { matched: true }
}

export const BACKFILL_FUNCTIONS = [slackBackfillRequested] as const
