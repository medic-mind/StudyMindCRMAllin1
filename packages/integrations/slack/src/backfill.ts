// Slack 90-day historic backfill worker (ADR 0017).
//
// Walks each watched channel via `conversations.history?oldest=<unix>` (plus
// each thread's replies, walkThread) and runs the existing slack-summary AI
// prompt against each message. Persists a `slack_summary` Interaction when the
// message resolves to a Contact / B2B account; otherwise — mirroring the LIVE
// webhook (jobs.ts) — it PARKS the message in the `UnassignedSummary` triage
// tray (/inbox/slack-mentions) instead of silently dropping it. The old
// behaviour (drop everything unmatched) is exactly why historic messages, and
// every name-only message when no AI provider is configured, "never showed up":
// a message that named a customer we hadn't imported yet, or that the AI
// couldn't extract, vanished with no record and no error. Parking makes them
// VISIBLE and lets the `slack/relink-unassigned` cron auto-link them the moment
// the contact exists (§12, ADR 0034). The noise filter (acks/emoji/bare links)
// is the volume control — those are still skipped, never parked. We NEVER
// auto-create a Contact from an unmatched message (§11/§12).
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

import { SLACK_API_BASE, listIngestChannelIds } from './client'
import { isComplaintChannel } from './channel-rules'
import { maybeRaiseComplaintFromSlack } from './complaints'
import {
  resolveSlackLinkTarget,
  resolveSlackLinkTargetFromNames,
  targetForeignKey,
} from './link-target'
import { extractContactSignals, extractNameCandidates, slackTextToPlain } from './extract'
import { isSkippableSlackNoise } from './noise'
import { resolveSlackNames } from './names'

interface BackfillRequestedData {
  jobId: string
  provider: 'slack'
  agentId: string | null
  windowFrom: string
  windowTo: string
}

export interface SlackHistoryMessage {
  type?: string
  subtype?: string
  ts: string
  user?: string
  text?: string
  permalink?: string
  /** Present on a threaded message; equals `ts` on the thread ROOT. */
  thread_ts?: string
  /** Only the thread ROOT carries this — how many replies hang off it. */
  reply_count?: number
  /** Thread ROOT only: ts of the newest reply. Lets the pull spot fresh
   *  replies on a thread whose root is older than the lookback window. */
  latest_reply?: string
  /** A bot/app post (e.g. the CRM's own #callsummaries announcement) — skipped. */
  bot_id?: string
  app_id?: string
}

export interface SlackHistoryResponse {
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
    // Channels to walk: the allowlist if set, else EVERY channel the bot is a
    // member of (auto-discovered). Previously this used getWatchedChannels()
    // directly, which is EMPTY when no allowlist is set — so the import pulled
    // from zero channels and nothing ever showed up.
    const channels = await step.run('resolve-channels', async () =>
      listIngestChannelIds({ token }),
    )
    if (channels.length === 0) {
      logger.warn({ jobId }, 'slack backfill: bot is in no channels — nothing to import')
    }

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
              // Process the message AND, when it is a thread root, every reply
              // hanging off it (conversations.history omits in-thread replies).
              const result = await step.run(`msg-${channelId}-${m.ts}`, async () =>
                processMessageWithReplies({ token, channelId, message: m, requestId: jobId }),
              )
              processed += result.processed
              matched += result.matched
              skipped += result.skipped
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

/** Attempts per Slack read call. conversations.history/replies are Tier-3
 *  rate-limited (~50/min); a workspace-wide pull WILL hit 429s, and the old
 *  behaviour (throw on the first one) killed the whole tick. */
const SLACK_GET_ATTEMPTS = 4
/** Cap on a single Retry-After wait so a step never hangs on a hostile value. */
const SLACK_GET_MAX_WAIT_S = 60

/**
 * Slack Web API GET with bounded rate-limit retries. Honours the 429
 * `Retry-After` header (Slack's documented behaviour) and retries the
 * `ratelimited` error body; every other error throws immediately.
 */
async function slackApiGet(
  token: string,
  endpoint: '/conversations.history' | '/conversations.replies',
  params: URLSearchParams,
): Promise<SlackHistoryResponse> {
  let lastError = 'unknown'
  for (let attempt = 0; attempt < SLACK_GET_ATTEMPTS; attempt += 1) {
    const res = await safeFetch(`${SLACK_API_BASE}${endpoint}?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const text = await res.text()
    let parsed: SlackHistoryResponse
    try {
      parsed = (text ? JSON.parse(text) : {}) as SlackHistoryResponse
    } catch {
      parsed = { ok: false, error: `http_${res.status}` }
    }
    if (parsed.ok) return parsed
    lastError = parsed.error ?? `http_${res.status}`
    const rateLimited = res.status === 429 || lastError === 'ratelimited'
    if (!rateLimited) break
    const retryAfter = Number(res.headers.get('retry-after'))
    const waitS = Math.min(
      Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 10,
      SLACK_GET_MAX_WAIT_S,
    )
    await new Promise((resolve) => setTimeout(resolve, waitS * 1000))
  }
  throw new Error(`slack ${endpoint.slice(1)} error: ${lastError}`)
}

export async function fetchHistory(
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
  return slackApiGet(token, '/conversations.history', params)
}

/**
 * Fetch a thread's replies via `conversations.replies`. Slack's
 * `conversations.history` returns thread ROOTS but not the replies inside them,
 * so without this every threaded reply about a customer is silently dropped
 * from the archive. The first message returned is the root itself (the caller
 * skips it — it was already processed from history). No `oldest` bound: we want
 * the whole thread while Slack still retains it (the point of the 90-day
 * bypass). Needs the `channels:history` scope already required for message
 * ingestion.
 */
export async function fetchReplies(
  token: string,
  channelId: string,
  threadTs: string,
  cursor: string | undefined,
  /** Bound the reply walk to replies at/after this UNIX second — used by the
   *  pull's old-thread scan so a long-lived thread isn't re-walked every tick.
   *  Omitted (the backfill case) = the whole thread. */
  oldest?: number,
): Promise<SlackHistoryResponse> {
  const params = new URLSearchParams({
    channel: channelId,
    ts: threadTs,
    limit: '100',
  })
  if (cursor) params.set('cursor', cursor)
  if (oldest !== undefined) params.set('oldest', String(oldest))
  return slackApiGet(token, '/conversations.replies', params)
}

/** Injectable deps for `walkThread` so the thread-walk logic (skip-root,
 *  paginate, inherit parent, tally) is unit-testable without real I/O. */
export interface ThreadWalkDeps {
  fetchReplies: (threadTs: string, cursor: string | undefined) => Promise<SlackHistoryResponse>
  process: (
    message: SlackHistoryMessage,
    threadParentText: string | null,
  ) => Promise<{ matched: boolean }>
}

export interface WalkTally {
  processed: number
  matched: number
  skipped: number
}

/** Bound on reply pages per thread — 30 × 100 = 3 000 replies, far beyond any
 *  real internal thread and a backstop against a runaway cursor loop. */
const MAX_REPLY_PAGES = 30

/**
 * Process a thread root and every reply hanging off it. Each reply is matched
 * to a customer in its own right; a reply that names no customer inherits the
 * root's customer via `threadParentText` — exactly how the live webhook handler
 * (jobs.ts) already treats threaded replies. Pure orchestration over injected
 * deps; one reply that throws is skipped, never aborting the thread.
 */
export async function walkThread(
  root: SlackHistoryMessage,
  deps: ThreadWalkDeps,
): Promise<WalkTally> {
  const tally: WalkTally = { processed: 0, matched: 0, skipped: 0 }
  const record = (r: { matched: boolean }) => {
    tally.processed += 1
    if (r.matched) tally.matched += 1
    else tally.skipped += 1
  }

  try {
    record(await deps.process(root, null))
  } catch {
    tally.processed += 1
    tally.skipped += 1
  }

  // Only a thread ROOT has replies to walk. `conversations.history` returns the
  // root with `reply_count`; a plain message has none.
  const isThreadRoot =
    (root.reply_count ?? 0) > 0 && (!root.thread_ts || root.thread_ts === root.ts)
  if (!isThreadRoot) return tally

  const parentText = root.text ?? null
  let cursor: string | undefined
  let page = 0
  do {
    let res: SlackHistoryResponse
    try {
      res = await deps.fetchReplies(root.ts, cursor)
    } catch {
      break // a thread we can't read must not abort the channel import
    }
    for (const reply of res.messages ?? []) {
      // conversations.replies returns the ROOT as its first element — already
      // processed above, so skip it to avoid a wasted AI re-parse.
      if (reply.ts === root.ts) continue
      try {
        record(await deps.process(reply, parentText))
      } catch {
        tally.processed += 1
        tally.skipped += 1
      }
    }
    cursor = res.has_more ? res.response_metadata?.next_cursor : undefined
    page += 1
  } while (cursor && page < MAX_REPLY_PAGES)

  return tally
}

/** Process a history message and, when it is a thread root, all of its replies.
 *  Wires the real `fetchReplies` + `processSlackMessage` into `walkThread`. */
export async function processMessageWithReplies(input: {
  token: string
  channelId: string
  message: SlackHistoryMessage
  requestId: string
}): Promise<WalkTally> {
  const { token, channelId, message, requestId } = input
  return walkThread(message, {
    fetchReplies: (threadTs, cursor) => fetchReplies(token, channelId, threadTs, cursor),
    process: (msg, threadParentText) =>
      processSlackMessage({ message: msg, channelId, requestId, threadParentText }),
  })
}

interface ProcessSlackInput {
  message: SlackHistoryMessage
  channelId: string
  requestId: string
  /** The thread root's text when this message is a reply — lets a reply that
   *  names no customer of its own inherit the customer named upthread. */
  threadParentText?: string | null
}

export async function processSlackMessage(input: ProcessSlackInput): Promise<{ matched: boolean }> {
  const { message, channelId } = input
  // Human-authored text messages only. Skip non-messages, edits/joins (subtype)
  // and — like the live handler (message-filter.ts) — any bot/app post, so the
  // backfill never re-ingests the CRM's OWN #callsummaries announcement as a
  // duplicate slack_summary (§3).
  if (
    message.type !== 'message' ||
    !message.text ||
    message.subtype ||
    message.bot_id ||
    message.app_id
  ) {
    return { matched: false }
  }

  // Idempotent on (channelId, ts) — already archived as a slack_summary.
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

  // Already captured in the triage tray (open, resolved, or dismissed). Skip
  // WITHOUT re-spending AI so re-running the import "many times" converges and
  // never re-parks a mention a human already dismissed (§32 cost control).
  const parkedAlready = await db.unassignedSummary.findUnique({
    where: { slackTs_channelId: { slackTs: message.ts, channelId } },
    select: { id: true },
  })
  if (parkedAlready) return { matched: false }

  // Free pre-filter (§32) — no AI spend on chatter that can't name a customer.
  // This is the volume control: acks/emoji/bare links are skipped, never parked.
  if (isSkippableSlackNoise(message.text)) return { matched: false }

  const { senderName: resolvedSender, channelName } = await resolveSlackNames({
    userId: message.user ?? null,
    channelId,
  })
  const senderName = resolvedSender ?? message.user ?? null

  // Deterministic pre-match FIRST (cheapest route; AI last — §32). The
  // call-log format carries the customer's phone/email verbatim, so the
  // backfill archives those mentions with zero AI spend — and still works
  // when no AI provider is configured at all. A threaded reply that names no
  // customer of its own inherits the phone/email named in the thread root
  // (threadParentText) — same rule as the live handler.
  const signals = extractContactSignals(message.text)
  const parentSignals = input.threadParentText
    ? extractContactSignals(input.threadParentText)
    : { email: null, phone: null }
  const matchEmail = signals.email ?? parentSignals.email
  const matchPhone = signals.phone ?? parentSignals.phone
  let rulesTarget =
    matchEmail || matchPhone
      ? await resolveSlackLinkTarget({ name: null, email: matchEmail, phone: matchPhone })
      : null

  // Free NAME pass (still no AI): the deterministic path used to hard-code
  // name:null, so "Spoke to Aanya Sharma about the mocks" could only link via
  // the AI — and never linked at all when no provider key was configured.
  // extractNameCandidates + the unambiguous-only matcher resolve it for free;
  // a reply that names nobody inherits the thread root's names, mirroring the
  // email/phone inheritance above.
  const nameCandidates = extractNameCandidates(message.text)
  const parentNameCandidates = input.threadParentText
    ? extractNameCandidates(input.threadParentText)
    : []
  if (!rulesTarget) {
    rulesTarget =
      (await resolveSlackLinkTargetFromNames(nameCandidates)) ??
      (parentNameCandidates.length > 0
        ? await resolveSlackLinkTargetFromNames(parentNameCandidates)
        : null)
  }

  if (rulesTarget) {
    const occurredAtRules = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)
    await db.interaction.create({
      data: {
        id: createId(),
        type: 'slack_summary',
        ...targetForeignKey(rulesTarget),
        occurredAt: occurredAtRules,
        summary: slackTextToPlain(message.text).slice(0, 280),
        payload: {
          backfill: true,
          event: 'slack.message_summarised',
          slackTs: message.ts,
          channelId,
          channelName,
          permalink: message.permalink ?? null,
          ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
          messageText: message.text ?? null,
          senderName,
          category: isComplaintChannel(channelName) ? 'complaint' : 'general',
          sentiment: 'neutral',
          suggestedNextAction: null,
          confidence: 1,
          matchedVia: rulesTarget.via,
          matchFuzzy: rulesTarget.fuzzy ?? false,
          linkedTo: rulesTarget.kind,
          promptVersion: 'rules-v1',
        },
      },
    })
    // Channel-aware rule (ADR 0042): a complaint-channel call summary that
    // linked to a contact also opens a Complaint. Best-effort + idempotent.
    await maybeRaiseComplaintFromSlack({
      contactId: rulesTarget.contactId ?? null,
      channelId,
      channelName,
      slackTs: message.ts,
      messageText: message.text,
      aiCategory: null,
      occurredAt: occurredAtRules,
    })
    return { matched: true }
  }

  const safeText = sanitiseUserContent(message.text)
  // Give the AI the thread root as context so a reply ("paid £40…") resolves to
  // the customer named upthread, not "no identifier found" — same as jobs.ts.
  const aiText = input.threadParentText
    ? `[Earlier in this thread] ${sanitiseUserContent(input.threadParentText)}\n\n[This message] ${safeText}`
    : safeText
  const prompt = buildSlackSummaryPrompt({
    channelName,
    authorDisplayName: senderName,
    text: aiText,
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
    // No AI provider (or over budget) must NOT silently drop the message — park
    // it as a record with the deterministic signals as the candidate, exactly
    // as the live handler does, so it stays visible + relinkable (never lost).
    // The extracted name candidate rides along so the relink cron can resolve
    // the row by name once the contact exists (a null name was un-rescuable).
    parsed = {
      candidateContactIdentifier: {
        name: nameCandidates[0] ?? parentNameCandidates[0] ?? null,
        email: matchEmail,
        phone: matchPhone,
      },
      summary: slackTextToPlain(message.text).slice(0, 600) || 'Slack message',
      category: 'general',
      sentiment: 'neutral',
      suggestedNextAction: null,
      confidence: 0,
    }
  }

  if (parsed.confidence < MATCH_THRESHOLD) {
    // Below the AI's confidence floor — park for human triage rather than drop.
    await parkUnassignedSummary({ message, channelId, parsed, senderName })
    return { matched: false }
  }

  // Shared resolver: Contact (email → phone → name) else B2B account (§12).
  const target = await resolveSlackLinkTarget(parsed.candidateContactIdentifier)
  if (!target) {
    // The AI named someone, but no Contact/account matches (yet). Park it — the
    // relink cron auto-links it once the customer is created (§12). Never
    // auto-create a Contact from an unmatched Slack message (§11/§12).
    await parkUnassignedSummary({ message, channelId, parsed, senderName })
    return { matched: false }
  }

  const occurredAt = new Date(Number(message.ts.split('.')[0] ?? 0) * 1000)
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'slack_summary',
      ...targetForeignKey(target),
      occurredAt,
      summary: parsed.summary.slice(0, 280),
      payload: {
        backfill: true,
        event: 'slack.message_summarised',
        slackTs: message.ts,
        channelId,
        channelName,
        permalink: message.permalink ?? null,
        ...(message.thread_ts ? { threadTs: message.thread_ts } : {}),
        // Archive the original message + author so the record outlives Slack's
        // 90-day window (ADR 0034). Category sorts the record.
        messageText: message.text ?? null,
        senderName,
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
  })
  await maybeRaiseComplaintFromSlack({
    contactId: target.contactId ?? null,
    channelId,
    channelName,
    slackTs: message.ts,
    messageText: message.text,
    aiCategory: parsed.category,
    occurredAt,
  })
  return { matched: true }
}

/**
 * Park a non-noise message we could not resolve to a Contact/account into the
 * `UnassignedSummary` triage tray — the same home the live webhook uses for
 * unmatched mentions (jobs.ts). Idempotent on (slackTs, channelId). This is
 * what turns "history is silently dropped" into "history shows up in the tray
 * and self-links via the relink cron once the customer exists".
 */
async function parkUnassignedSummary(input: {
  message: SlackHistoryMessage
  channelId: string
  parsed: SlackSummary
  senderName: string | null
}): Promise<void> {
  const { message, channelId, parsed, senderName } = input
  await db.unassignedSummary.upsert({
    where: { slackTs_channelId: { slackTs: message.ts, channelId } },
    create: {
      id: createId(),
      slackTs: message.ts,
      channelId,
      parsed: parsed as unknown as object,
      confidence: parsed.confidence,
      messageText: message.text ?? null,
      senderName,
    },
    update: {
      parsed: parsed as unknown as object,
      confidence: parsed.confidence,
      messageText: message.text ?? null,
      senderName,
    },
  })
}

export const BACKFILL_FUNCTIONS = [slackBackfillRequested] as const
