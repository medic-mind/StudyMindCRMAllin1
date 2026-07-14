// Gmail Inngest functions. CLAUDE.md §14, §17.
//
// gmailHistoryChanged: receives { emailAddress, historyId }, looks up the
// GmailMailbox, fetches users.history.list(startHistoryId) for additions,
// for each new message: fetch full message, persist Email Interaction(s),
// match Contacts by every address (many-to-many), stream attachments to S3.
// Idempotent on Gmail message id.
//
// gmailRefreshWatch: recurring 06:00 UTC. Renews any watch that expires
// within 24h. Watch lifetime is 7 days; we target renewal at 6 days.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { BackfillAlreadyRunningError, startBackfill } from '@studymind/core/backfill'
import { flag } from '@studymind/core/flags'
import {
  applyMailFlagsToConversation,
  applyMailToConversation,
  prepareEmailHtml,
} from '@studymind/core/mail'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import {
  createClientForAgent,
  customLabelNames,
  isInvalidGrantError,
  isNotFoundError,
  markNeedsReconnect,
  getHeader,
  parseAddresses,
  parseFromName,
  type GmailMessage,
} from './client'
import { primaryAccountByContact } from './business-account-link'
import { ensureAllMailAccountBridges } from './mail-account-bridge'
import { isGoogleVoiceSender } from './google-voice'
import { handleGoogleVoiceMessage } from './google-voice-handler'
import { putAttachment } from './s3'
import { deriveThreadFlags, DELETED_THREAD_FLAGS } from './thread-flags'

/** Floor/ceiling for the catch-up backfill fired when a history cursor
 *  expires or bootstraps. Gmail retains ~a week of history, but the CURSOR
 *  may have been dead far longer than that — the window must cover the whole
 *  stall, not the retention period. */
const GAP_BACKFILL_MIN_DAYS = 7
const GAP_BACKFILL_MAX_DAYS = 90

/** Full-mirror auto-deepening: the sync cron keeps extending each agent's
 *  imported history backwards in 90-day chunks (one in-flight chunk per
 *  agent) until this horizon is reached, so the WHOLE mailbox lands on the
 *  customer timelines automatically — no manual "Import history" needed.
 *  Override with GMAIL_MIRROR_HORIZON_DAYS; default 10 years. */
const DEEPEN_CHUNK_DAYS = 90
function mirrorHorizonDays(): number {
  const raw = Number(process.env['GMAIL_MIRROR_HORIZON_DAYS'] ?? '')
  return Number.isInteger(raw) && raw > 0 ? raw : 3650
}

/**
 * For every agent with a live mailbox, look at how far back their COMPLETED
 * Gmail backfills reach and enqueue the next 90-day chunk further into the
 * past (idempotent — an in-flight chunk blocks a duplicate). Progress state
 * IS the BackfillJob history, so this needs no new table and a manual
 * "Everything" import simply completes the walk early.
 */
async function autoDeepenGmailMirror(
  logger: { warn: (...a: unknown[]) => void },
  requestId: string,
): Promise<{ enqueued: number; done: number }> {
  const horizon = new Date(Date.now() - mirrorHorizonDays() * 24 * 60 * 60 * 1000)
  const mailboxAgents = await db.gmailMailbox.findMany({
    where: { deletedAt: null },
    select: { agentId: true },
    distinct: ['agentId'],
    take: 50,
  })
  let enqueued = 0
  let done = 0
  for (const { agentId } of mailboxAgents) {
    try {
      const earliest = await db.backfillJob.findFirst({
        where: { provider: 'gmail', agentId, status: 'completed' },
        orderBy: { windowFrom: 'asc' },
        select: { windowFrom: true },
      })
      if (!earliest) {
        // No completed import yet — the connect flow's initial 90-day job is
        // either still running or was never started (legacy connect). Start
        // it; BackfillAlreadyRunningError below covers the in-flight case.
        await startBackfill(db, inngest, {
          provider: 'gmail',
          agentId,
          windowDays: DEEPEN_CHUNK_DAYS,
          ctx: { actorId: null, requestId },
        })
        enqueued += 1
        continue
      }
      if (earliest.windowFrom.getTime() <= horizon.getTime()) {
        done += 1
        continue
      }
      await startBackfill(db, inngest, {
        provider: 'gmail',
        agentId,
        windowDays: DEEPEN_CHUNK_DAYS,
        windowTo: earliest.windowFrom,
        ctx: { actorId: null, requestId },
      })
      enqueued += 1
    } catch (err) {
      if (err instanceof BackfillAlreadyRunningError) continue
      logger.warn({ agentId, err }, 'gmail auto-deepen: skipping agent')
    }
  }
  return { enqueued, done }
}

/** How many days of mail to re-import after a cursor expiry/bootstrap: since
 *  the mailbox row was last touched (every successful sync advances
 *  `historyId`, bumping `updatedAt`, so this approximates the stall length),
 *  plus slack, clamped to [7, 90]. */
async function gapBackfillWindowDays(address: string): Promise<number> {
  const mb = await db.gmailMailbox.findUnique({
    where: { address },
    select: { updatedAt: true },
  })
  if (!mb) return GAP_BACKFILL_MIN_DAYS
  const stalledDays = Math.ceil(
    (Date.now() - mb.updatedAt.getTime()) / (24 * 60 * 60 * 1000),
  )
  return Math.min(GAP_BACKFILL_MAX_DAYS, Math.max(GAP_BACKFILL_MIN_DAYS, stalledDays + 2))
}

interface HistoryChangedData {
  eventId: string
  providerEventRowId: string
  emailAddress: string
  historyId: string
}

/** Minimal Inngest `step` surface the shared sync helpers need. */
type StepRunner = { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }

interface MailboxToSync {
  id: string
  agentId: string
  address: string
  historyId: string | null
}

/**
 * Sync ONE mailbox forward from its stored historyId: pull new messages +
 * changed-thread flags from Gmail's history feed and converge them onto the
 * Conversation heads, then advance the cursor. This is the SHARED engine behind
 * BOTH the real-time push handler (`gmail/history.changed`) and the recurring
 * `gmail/sync` poll — so the CRM stays in step with Gmail even when Pub/Sub push
 * isn't delivering (the common self-hosted case), exactly like the Trengo /
 * Aircall reconcile crons. Idempotent + convergent.
 *
 * `keyPrefix` namespaces the step ids so a single poll can sweep many mailboxes
 * without step-id collisions. The push handler passes '' to keep its step ids
 * stable.
 */
async function syncMailboxHistory(
  step: StepRunner,
  input: { mailbox: MailboxToSync; startHistoryId: string; requestId: string; keyPrefix: string },
  logger: { warn: (...a: unknown[]) => void },
): Promise<{
  status: 'ok' | 'needs_reconnect' | 'reanchored'
  processed: number
  flagsMirrored: number
}> {
  const { mailbox, startHistoryId, requestId, keyPrefix } = input
  const address = mailbox.address

  // IMPORTANT: expected failures (expired cursor, revoked token) are detected
  // INSIDE the step and returned as a sentinel. A thrown error crosses the
  // Inngest step boundary as a serialised StepError that keeps only
  // name/message/stack — a Gmail 404's `status` field is lost, so
  // `isNotFoundError` can never match outside the step and the recovery path
  // would be dead code. (invalid_grant survives only via its message text —
  // the sentinel makes both robust.)
  const listed = await step.run(`${keyPrefix}list-history`, async () => {
    const client = await createClientForAgent({
      agentId: mailbox.agentId,
      address,
      purpose: 'gmail.sync',
      requestId,
    })
    try {
      return { ok: true as const, result: await client.listHistorySince(startHistoryId) }
    } catch (err) {
      if (isInvalidGrantError(err)) return { ok: false as const, reason: 'invalid_grant' as const }
      if (isNotFoundError(err)) return { ok: false as const, reason: 'expired_cursor' as const }
      throw err
    }
  })

  if (!listed.ok && listed.reason === 'invalid_grant') {
    logger.warn(
      { agentId: mailbox.agentId, requestId },
      'gmail refresh token rejected (invalid_grant) — marking needs_reconnect',
    )
    await step.run(`${keyPrefix}mark-needs-reconnect`, async () =>
      markNeedsReconnect(mailbox.agentId),
    )
    await step.run(`${keyPrefix}audit-needs-reconnect`, async () =>
      writeAuditLogEntry(db, {
        actorId: null,
        action: 'gmail.oauth_needs_reconnect',
        target: { type: 'User', id: mailbox.agentId },
        requestId,
      }),
    )
    return { status: 'needs_reconnect', processed: 0, flagsMirrored: 0 }
  }

  if (!listed.ok) {
    // The stored cursor is OLDER than Gmail's retained history window
    // (~a week) — Gmail 404s it forever. Without recovery this mailbox
    // stalls permanently: every tick replays the same expired cursor and
    // new mail never lands ("Gmail looks completely different to the CRM").
    // Re-anchor at the profile's CURRENT historyId so incremental sync
    // resumes, and fire an idempotent backfill sized to the ACTUAL stall
    // (how long since this mailbox last successfully synced) so the gap's
    // mail is imported too.
    logger.warn(
      { address, startHistoryId, requestId },
      'gmail history cursor expired (404) — re-anchoring and backfilling the gap',
    )
    const reanchor = await step.run(`${keyPrefix}reanchor-history`, async () => {
      // Read the stall length BEFORE writing the new cursor — the update
      // bumps `updatedAt`, which is what the window derives from.
      const windowDays = await gapBackfillWindowDays(address)
      const client = await createClientForAgent({
        agentId: mailbox.agentId,
        address,
        purpose: 'gmail.sync',
        requestId,
      })
      const current = await client.getCurrentHistoryId()
      if (current) {
        await db.gmailMailbox.update({
          where: { address },
          data: { historyId: current },
        })
      }
      return { current, windowDays }
    })
    await step.run(`${keyPrefix}backfill-gap`, async () => {
      try {
        const res = await startBackfill(db, inngest, {
          provider: 'gmail',
          agentId: mailbox.agentId,
          windowDays: reanchor.windowDays,
          ctx: { actorId: null, requestId },
        })
        return res.jobId
      } catch (backfillErr) {
        if (backfillErr instanceof BackfillAlreadyRunningError) {
          return backfillErr.existingJobId
        }
        throw backfillErr
      }
    })
    return { status: 'reanchored', processed: 0, flagsMirrored: 0 }
  }

  const result = listed.result

  // Fetch the account's label id→name map once so new messages can carry their
  // custom Gmail labels onto the head (drives the label chips + folder state).
  const labelMap =
    result.added.length === 0 && result.changedThreadIds.length === 0
      ? {}
      : await step.run(`${keyPrefix}load-labels`, async () => {
          const client = await createClientForAgent({
            agentId: mailbox.agentId,
            address,
            purpose: 'gmail.sync',
            requestId,
          })
          const labels = await client.listLabels()
          return Object.fromEntries(labels.map((l) => [l.id, l.name]))
        })

  for (const added of result.added) {
    // Per-message step lets a single bad message land in DLQ rather than
    // poisoning the whole history sync.
    await step.run(`${keyPrefix}process-${added.messageId}`, async () =>
      processMessage({
        agentId: mailbox.agentId,
        mailboxId: mailbox.id,
        address,
        messageId: added.messageId,
        requestId,
        labelMap,
      }),
    )
  }

  // Inbound two-way sync (ADR 0021 Phase 5): threads whose Gmail flags changed
  // (read / star / archive / trash / label) without a new message. Re-read each
  // thread's current label state and mirror it onto the head, so a change made
  // in the Gmail UI shows in the CRM. Idempotent + convergent — re-running
  // yields the same head, and our own outbound echoes are no-ops.
  for (const threadId of result.changedThreadIds) {
    await step.run(`${keyPrefix}flags-${threadId}`, async () =>
      mirrorThreadFlags({
        agentId: mailbox.agentId,
        address,
        threadId,
        requestId,
        labelMap,
      }),
    )
  }

  await step.run(`${keyPrefix}advance-history`, async () =>
    db.gmailMailbox.update({
      where: { address },
      data: { historyId: result.newHistoryId },
    }),
  )

  return {
    status: 'ok',
    processed: result.added.length,
    flagsMirrored: result.changedThreadIds.length,
  }
}

export const gmailHistoryChanged = inngest.createFunction(
  {
    id: 'gmail/history.changed',
    name: 'Sync Gmail history additions for an agent mailbox',
    concurrency: { limit: 5 },
    retries: 6,
  },
  { event: 'gmail/history.changed' },
  async ({ event, step, logger }) => {
    const data = event.data as HistoryChangedData
    const { eventId, providerEventRowId, emailAddress, historyId } = data

    const mailbox = await step.run('load-mailbox', async () =>
      db.gmailMailbox.findUnique({
        where: { address: emailAddress },
        select: { id: true, agentId: true, address: true, historyId: true },
      }),
    )
    if (!mailbox) {
      logger.warn({ eventId, emailAddress }, 'gmail mailbox not found — skip')
      await step.run('mark-processed', async () => markProcessed(providerEventRowId))
      return { skipped: true }
    }

    const res = await syncMailboxHistory(
      // Inngest's step.run returns a JSON-serialized result type; our helpers
      // only move plain string values across the boundary, so this narrowing is
      // safe.
      step as unknown as StepRunner,
      {
        mailbox,
        startHistoryId: mailbox.historyId ?? historyId,
        requestId: eventId,
        keyPrefix: '',
      },
      logger,
    )
    await step.run('mark-processed', async () => markProcessed(providerEventRowId))
    if (res.status === 'needs_reconnect') {
      return { skipped: true, reason: 'needs_reconnect' as const }
    }
    return { ok: true, processed: res.processed, flagsMirrored: res.flagsMirrored }
  },
)

interface MirrorThreadFlagsInput {
  agentId: string
  /** The mailbox to act as (its own token — multi-account). */
  address: string
  threadId: string
  requestId: string
  /** Gmail label id→name map so the mirror also converges the head's custom
   *  label chips, not just read/star/archive/trash. */
  labelMap?: Record<string, string>
}

/**
 * Re-read a thread's CURRENT Gmail label state (the union across all its
 * messages) and converge the Conversation head onto it — the inbound half of
 * two-way sync (ADR 0021 Phase 5) AND the source of the authoritative folder
 * state. Writes the read/star/archive/trash flags, the custom-label chips, and
 * the FULL Gmail label-id set (`gmailLabelIds`) that /mail's Gmail-native
 * folders read, so the CRM mirrors Gmail's Inbox / tabs / Spam / Important /
 * Sent exactly. A null head (message never synced) is a no-op; a 404 (thread
 * permanently deleted) marks it trashed rather than hard-deleting it (§3).
 *
 * Takes a pre-built client so the live message path can reuse its own client
 * (one OAuth/KMS decrypt) instead of constructing another per thread.
 */
async function convergeThreadStateToHead(
  client: { getThreadState: (id: string) => Promise<{ labelIds: string[] } | null> },
  threadId: string,
  idToName: ReadonlyMap<string, string>,
): Promise<void> {
  const state = await client.getThreadState(threadId)
  const flags = state ? deriveThreadFlags(state.labelIds) : DELETED_THREAD_FLAGS
  // Permanently-deleted threads are reported as Trash so they leave the active
  // mailbox but stay recoverable/auditable (§3 — no silent delete).
  const gmailLabelIds = state ? state.labelIds : ['TRASH']
  const labels = state ? customLabelNames(state.labelIds, idToName) : []
  await applyMailFlagsToConversation(db, {
    provider: 'email',
    externalThreadId: threadId,
    flags,
    syncedAt: new Date(),
    labels,
    gmailLabelIds,
  })
}

/**
 * Re-read a thread's current Gmail label state and mirror it onto the
 * Conversation head (ADR 0021 Phase 5 — inbound half of two-way sync). A null
 * head (message never synced) is a no-op; a 404 from Gmail (thread permanently
 * deleted) marks the head trashed rather than hard-deleting it (§3).
 */
async function mirrorThreadFlags(input: MirrorThreadFlagsInput): Promise<void> {
  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.address,
    purpose: 'gmail.sync',
    requestId: input.requestId,
  })
  await convergeThreadStateToHead(
    client,
    input.threadId,
    new Map(Object.entries(input.labelMap ?? {})),
  )
}

interface ProcessMessageInput {
  agentId: string
  /** GmailMailbox.id the sync is running for — used to resolve the MailAccount
   *  this thread belongs to (ADR 0021 Phase 3b). */
  mailboxId: string
  /** The mailbox address to act as (its own token — multi-account). */
  address: string
  messageId: string
  requestId: string
  /** Gmail label id→name map for surfacing custom labels on the head. */
  labelMap: Record<string, string>
}

async function processMessage(input: ProcessMessageInput): Promise<void> {
  // Idempotent on Gmail message id (CLAUDE.md §14).
  const existing = await db.interaction.findFirst({
    where: { payload: { path: ['gmailMessageId'], equals: input.messageId } },
    select: { id: true },
  })
  if (existing) return

  const client = await createClientForAgent({
    address: input.address,
    agentId: input.agentId,
    purpose: 'gmail.sync',
    requestId: input.requestId,
  })
  const message: GmailMessage = await client.getMessage(input.messageId)

  const fromHeader = getHeader(message.headers, 'From')
  const toHeader = getHeader(message.headers, 'To')
  const ccHeader = getHeader(message.headers, 'Cc')
  const bccHeader = getHeader(message.headers, 'Bcc')
  const subject = getHeader(message.headers, 'Subject') ?? ''
  const messageIdHeader = getHeader(message.headers, 'Message-ID')

  const fromAddrs = parseAddresses(fromHeader)
  const toAddrs = parseAddresses(toHeader)
  const ccAddrs = parseAddresses(ccHeader)
  const bccAddrs = parseAddresses(bccHeader)

  // Google Voice notification emails (voicemail / missed call / text) are how
  // we ingest that channel — it has no call API (ADR 0032). Behind a flag so
  // it stays off until a Google Voice number points at a synced mailbox.
  if (
    isGoogleVoiceSender(fromAddrs) &&
    (await flag('google_voice.email_ingest_enabled'))
  ) {
    const handled = await handleGoogleVoiceMessage({
      message,
      agentId: input.agentId,
      requestId: input.requestId,
      subject,
      client,
    })
    if (handled) return
  }

  // Determine direction. If any of the agent's addresses is in From, it's
  // outbound. Multi-mailbox: an agent can have several connected Gmail
  // accounts; we treat all of them as "the agent".
  const agentAddrs = (
    await db.gmailMailbox.findMany({
      where: { agentId: input.agentId, deletedAt: null },
      select: { address: true },
    })
  ).map((m) => m.address.toLowerCase())
  const direction = agentAddrs.some((a) => fromAddrs.includes(a))
    ? 'sent'
    : 'received'

  // The real sender's identity for the Gmail-style list: the From display name
  // when present, else the From email ADDRESS — NEVER a matched CRM contact, so
  // a no-display-name sender (system / no-reply mail) shows its real address
  // instead of collapsing every thread onto one matched contact.
  const senderName =
    direction === 'received' ? (parseFromName(fromHeader) ?? fromAddrs[0] ?? null) : null
  const idToName = new Map(Object.entries(input.labelMap))
  const labels = customLabelNames(message.labelIds, idToName)

  // Match Contacts by every address (many-to-many — §14).
  const allAddrs = Array.from(
    new Set([...fromAddrs, ...toAddrs, ...ccAddrs, ...bccAddrs]),
  ).filter((a) => !agentAddrs.includes(a))
  // Case-INSENSITIVE email match — a contact stored as "John.Smith@x.com" must
  // match the lowercased header address, else the email never reaches the
  // customer's timeline (§14). `in` is case-sensitive on Postgres, so OR each.
  const matchedContacts =
    allAddrs.length > 0
      ? await db.contact.findMany({
          where: {
            deletedAt: null,
            OR: allAddrs.map((a) => ({ email: { equals: a, mode: 'insensitive' as const } })),
          },
          select: { id: true, email: true },
        })
      : []
  // Resolve the B2B school/account each matched contact belongs to, so the
  // email also lands on the account's Activity timeline (parity with notes /
  // tasks, which stamp Interaction.businessAccountId).
  const accountByContact = await primaryAccountByContact(
    matchedContacts.map((c) => c.id),
  )

  // Stream attachments to S3 first; we reference them by key in payload.
  const attachmentRefs: Array<{
    s3Key: string
    filename: string
    mimeType: string
    sizeBytes: number
  }> = []
  for (const att of message.attachments) {
    const body = await client.getAttachment(message.id, att.attachmentId)
    const { s3Key } = await putAttachment({
      messageId: message.id,
      attachmentId: att.attachmentId,
      filename: att.filename,
      body,
      contentType: att.mimeType,
    })
    attachmentRefs.push({
      s3Key,
      filename: att.filename,
      mimeType: att.mimeType,
      sizeBytes: att.sizeBytes,
    })
  }

  const occurredAt = new Date(message.internalDate || Date.now())
  const eventName = direction === 'sent' ? 'email.sent' : 'email.received'
  const dbType = direction === 'sent' ? 'email_sent' : 'email_received'
  // Sanitised + size-capped HTML body for the reading pane's sandboxed iframe
  // (ADR 0041). Null falls back to the plaintext `body` already captured.
  const bodyHtml = prepareEmailHtml(message.htmlBody)

  // Persist one Interaction per matched Contact so each timeline shows the
  // full thread (CLAUDE.md §14). When no contact matches, we still record
  // a single Interaction with no contactId so the audit log stays complete.
  if (matchedContacts.length === 0) {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: dbType,
        contactId: null,
        occurredAt,
        summary: subject.slice(0, 280),
        payload: {
          event: eventName,
          gmailMessageId: message.id,
          gmailThreadId: message.threadId,
          messageIdHeader,
          from: fromAddrs,
          to: toAddrs,
          cc: ccAddrs,
          bcc: bccAddrs,
          subject,
          senderName,
          bodyHtml,
          attachments: attachmentRefs,
        },
      },
      select: { id: true },
    })
    await writeAuditLogEntry(db, {
      actorId: null,
      action: eventName,
      target: { type: 'Interaction', id: created.id },
      requestId: input.requestId,
      after: { gmailMessageId: message.id, matchedContacts: 0 },
    })
  }

  for (const contact of matchedContacts) {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: dbType,
        contactId: contact.id,
        businessAccountId: accountByContact.get(contact.id) ?? null,
        occurredAt,
        summary: subject.slice(0, 280),
        payload: {
          event: eventName,
          gmailMessageId: message.id,
          gmailThreadId: message.threadId,
          messageIdHeader,
          from: fromAddrs,
          to: toAddrs,
          cc: ccAddrs,
          bcc: bccAddrs,
          matchedVia: contact.email,
          subject,
          senderName,
          bodyHtml,
          attachments: attachmentRefs,
        },
      },
      select: { id: true },
    })
    await writeAuditLogEntry(db, {
      actorId: null,
      action: eventName,
      target: { type: 'Contact', id: contact.id },
      requestId: input.requestId,
      after: {
        interactionId: created.id,
        gmailMessageId: message.id,
        attachments: attachmentRefs.length,
      },
    })
  }

  // ADR 0021 Phase 3b — upsert the email Conversation head so the thread shows
  // in the unified Comms Centre next to Trengo conversations. Keyed on
  // (provider='email', externalThreadId=gmailThreadId); never duplicates the
  // message body (that lives in the Interaction above). Resolve the owning
  // MailAccount via the GmailMailbox bridge when it has been imported.
  const account = await db.mailAccount.findFirst({
    where: { gmailMailboxId: input.mailboxId, deletedAt: null },
    select: { id: true },
  })
  await applyMailToConversation(db, {
    provider: 'email',
    externalThreadId: message.threadId,
    mailAccountId: account?.id ?? null,
    direction: direction === 'sent' ? 'sent' : 'received',
    occurredAt,
    contactId: matchedContacts[0]?.id ?? null,
    familyId: null,
    subject: subject || null,
    senderName,
    labels,
    // Best-effort initial folder state from this message; the thread-union
    // converge below overwrites it with the authoritative set.
    gmailLabelIds: message.labelIds,
  })

  // Converge the head onto the thread's CURRENT Gmail label state (the union
  // across every message) so /mail's Inbox / tabs / Spam / Important / Sent
  // match Gmail's own views from the first sync. Run for BOTH directions: a
  // sent-only thread that was archived/starred in Gmail must land in the right
  // folder too — deriving from a single sent message (which lacks INBOX) would
  // false-archive, so we read the thread union instead. Reuses this message's
  // client (no extra OAuth/KMS decrypt).
  await convergeThreadStateToHead(client, message.threadId, idToName)
}

// -----------------------------------------------------------------------------
// gmailRefreshWatch: recurring 06:00 UTC (§17.1).
// -----------------------------------------------------------------------------

export const gmailRefreshWatch = inngest.createFunction(
  {
    id: 'gmail/refresh-watch',
    name: 'Renew Gmail Pub/Sub watches that expire within 24h',
    concurrency: { limit: 3 },
    retries: 3,
  },
  { cron: '0 6 * * *' },
  async ({ step, logger }) => {
    const cutoff = new Date(Date.now() + 24 * 60 * 60 * 1000)

    const due = await step.run('list-due-mailboxes', async () =>
      db.gmailMailbox.findMany({
        where: {
          deletedAt: null,
          OR: [{ watchExpiresAt: null }, { watchExpiresAt: { lt: cutoff } }],
        },
        select: { id: true, agentId: true, address: true, topicName: true },
      }),
    )

    for (const mb of due) {
      if (!mb.topicName) {
        logger.warn({ agentId: mb.agentId }, 'gmail mailbox has no topicName — skip')
        continue
      }
      await step.run(`renew-${mb.id}`, async () => {
        try {
          const client = await createClientForAgent({
            agentId: mb.agentId,
            address: mb.address,
            purpose: 'gmail.refresh-watch',
          })
          const result = await client.setupWatch({
            topicName: mb.topicName as string,
          })
          await db.gmailMailbox.update({
            where: { id: mb.id },
            data: {
              historyId: result.historyId,
              watchExpiresAt: new Date(result.expirationMs),
            },
          })
        } catch (err) {
          if (isInvalidGrantError(err)) {
            logger.warn(
              { agentId: mb.agentId },
              'gmail refresh-watch invalid_grant — marking needs_reconnect',
            )
            await markNeedsReconnect(mb.agentId)
            await writeAuditLogEntry(db, {
              actorId: null,
              action: 'gmail.oauth_needs_reconnect',
              target: { type: 'User', id: mb.agentId },
            })
            return
          }
          throw err
        }
      })
    }

    return { renewed: due.length }
  },
)

async function markProcessed(providerEventRowId: string): Promise<void> {
  await db.providerEvent.update({
    where: { id: providerEventRowId },
    data: { processedAt: new Date() },
  })
}

// -----------------------------------------------------------------------------
// gmail/sync — the push-independent safety net (§17.1). Mirrors the Trengo /
// Aircall reconcile crons: webhooks/push are the fast path, this poll is what
// guarantees "open Gmail == open the CRM" even when Pub/Sub push isn't
// delivering. Each tick (a) pulls every connected mailbox forward from its
// historyId (new mail + Gmail-side read/star/archive/trash/label changes) and
// (b) heals a bounded round-robin batch of existing heads onto Gmail's current
// thread state — so legacy heads converge their flags + full label set without
// anyone clicking "Resync".
// -----------------------------------------------------------------------------

/** Mailboxes pulled forward per tick. */
const SYNC_MAILBOX_CAP = 50
/** Existing heads re-read against Gmail's current thread state per tick
 *  (oldest `flagsSyncedAt` first), sweeping the whole population over time. */
const HEAL_BATCH = 40

/**
 * Re-read a bounded batch of the least-recently-synced email heads against
 * Gmail's CURRENT thread state and converge them (flags + custom-label chips +
 * the full `gmailLabelIds` folder set). Oldest `flagsSyncedAt` first (nulls —
 * never-synced legacy heads — first) so the population is swept fairly and no
 * row is starved. A broken account (invalid_grant) stamps its heads forward so
 * the sweep is never stuck on it.
 */
async function healEmailHeads(
  step: StepRunner,
  requestId: string,
  logger: { warn: (...a: unknown[]) => void },
): Promise<{ healed: number; adopted: number }> {
  // Orphan heads (mailAccountId null — synced before the account bridge
  // existed) are INCLUDED: they are adopted below by asking each connected
  // account whether it owns the thread. Excluding them left every
  // pre-bridge thread permanently un-healed, so its folder/label state never
  // converged with Gmail.
  const heads = await step.run('heal-load-heads', async () =>
    db.conversation.findMany({
      where: {
        provider: 'email',
        externalThreadId: { not: null },
      },
      orderBy: [{ flagsSyncedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
      take: HEAL_BATCH,
      select: { id: true, externalThreadId: true, mailAccountId: true },
    }),
  )
  if (heads.length === 0) return { healed: 0, adopted: 0 }

  const accounts = await step.run('heal-load-accounts', async () =>
    db.mailAccount.findMany({
      where: {
        provider: 'gmail',
        deletedAt: null,
        ownerUserId: { not: null },
      },
      select: { id: true, ownerUserId: true, address: true },
    }),
  )
  const accById = new Map(accounts.map((a) => [a.id, a]))

  // Adopt orphans: probe each connected account for the thread; the first
  // account Gmail confirms owns it claims the head (sets mailAccountId) and
  // converges its state in the same call. A thread no account can see is
  // stamped forward so the sweep never sticks on it.
  const orphans = heads.filter((h) => !h.mailAccountId && h.externalThreadId)
  let adopted = 0
  if (orphans.length > 0 && accounts.length > 0) {
    adopted = await step.run('heal-adopt-orphans', async () => {
      let count = 0
      const clients = new Map<
        string,
        Awaited<ReturnType<typeof createClientForAgent>> | null
      >()
      const labelMaps = new Map<string, Map<string, string>>()
      for (const head of orphans) {
        let claimed = false
        for (const acc of accounts) {
          try {
            let client = clients.get(acc.id)
            if (client === undefined) {
              client = await createClientForAgent({
                agentId: acc.ownerUserId as string,
                address: acc.address,
                purpose: 'gmail.sync',
                requestId,
              })
              clients.set(acc.id, client)
              const labels = await client.listLabels()
              labelMaps.set(acc.id, new Map(labels.map((l) => [l.id, l.name])))
            }
            if (client === null) continue
            const state = await client.getThreadState(head.externalThreadId as string)
            if (!state) continue
            await db.conversation.update({
              where: { id: head.id },
              data: { mailAccountId: acc.id },
            })
            await convergeThreadStateToHead(
              client,
              head.externalThreadId as string,
              labelMaps.get(acc.id) ?? new Map(),
            )
            claimed = true
            count += 1
            break
          } catch (err) {
            // A broken account must not block adoption via the others.
            clients.set(acc.id, null)
            if (isInvalidGrantError(err)) {
              await markNeedsReconnect(acc.ownerUserId as string)
            }
            logger.warn(
              { mailAccountId: acc.id, err },
              'gmail heal: adoption probe failed for account',
            )
          }
        }
        if (!claimed) {
          await db.conversation.update({
            where: { id: head.id },
            data: { flagsSyncedAt: new Date() },
          })
        }
      }
      return count
    })
  }

  let healed = 0
  for (const acc of accounts) {
    const accHeads = heads.filter(
      (h) => h.mailAccountId === acc.id && h.externalThreadId,
    )
    if (accHeads.length === 0) continue
    const done = await step.run(`heal-account-${acc.id}`, async () => {
      try {
        const client = await createClientForAgent({
          agentId: acc.ownerUserId as string,
          address: acc.address,
          purpose: 'gmail.sync',
          requestId,
        })
        const labels = await client.listLabels()
        const idToName = new Map(labels.map((l) => [l.id, l.name]))
        for (const head of accHeads) {
          await convergeThreadStateToHead(
            client,
            head.externalThreadId as string,
            idToName,
          )
        }
        return accHeads.length
      } catch (err) {
        // A broken mailbox must not stick the round-robin: stamp its heads
        // forward (so the sweep advances) and mark it for reconnect on auth
        // failure. The next full sync's history pull surfaces other errors.
        if (isInvalidGrantError(err)) {
          await markNeedsReconnect(acc.ownerUserId as string)
        }
        logger.warn(
          { mailAccountId: acc.id, err },
          'gmail heal: account batch failed — stamping heads forward',
        )
        await db.conversation.updateMany({
          where: { id: { in: accHeads.map((h) => h.id) } },
          data: { flagsSyncedAt: new Date() },
        })
        return 0
      }
    })
    healed += done
  }

  // Heads pointing at a non-Gmail / vanished account can't be converged — stamp
  // them so the oldest-first cursor keeps moving. (Orphans were handled by the
  // adoption pass above.)
  const unresolved = heads.filter(
    (h) => h.mailAccountId && !accById.has(h.mailAccountId),
  )
  if (unresolved.length > 0) {
    await step.run('heal-stamp-unresolved', async () =>
      db.conversation.updateMany({
        where: { id: { in: unresolved.map((h) => h.id) } },
        data: { flagsSyncedAt: new Date() },
      }),
    )
  }

  return { healed, adopted }
}

/** Sweep every connected mailbox (history pull) + heal a round-robin batch.
 *  Shared by the recurring cron and the on-demand "Sync from Gmail" button. */
async function runFullGmailSync(
  step: StepRunner,
  requestId: string,
  logger: { warn: (...a: unknown[]) => void },
): Promise<{
  mailboxes: number
  processed: number
  flagsMirrored: number
  healed: number
  adopted: number
  failed: number
  deepened: { enqueued: number; done: number }
}> {
  // Every live GmailMailbox must have a MailAccount bridge — head attribution
  // and the /mail account rail both hang off it, and the OAuth connect of
  // older deploys never created one. Idempotent + cheap.
  await step.run('ensure-mail-account-bridges', async () => {
    try {
      return await ensureAllMailAccountBridges()
    } catch (err) {
      logger.warn({ err }, 'gmail sync: bridge ensure failed — continuing')
      return 0
    }
  })

  // Include mailboxes with a NULL cursor: a mailbox whose watch setup failed
  // at connect time never got a historyId, and excluding it here made it
  // invisible to the poll forever. It bootstraps below.
  const mailboxes = await step.run('sync-load-mailboxes', async () =>
    db.gmailMailbox.findMany({
      where: { deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      take: SYNC_MAILBOX_CAP,
      select: { id: true, agentId: true, address: true, historyId: true },
    }),
  )

  let processed = 0
  let flagsMirrored = 0
  let failed = 0
  for (const mb of mailboxes) {
    // Each mailbox is isolated: one broken account (expired token, transient
    // 5xx) must not abort the sweep for every other mailbox AND kill the
    // heal below — that is how a single stale connection froze the whole
    // mirror. Errors are logged and the sweep moves on; the failing mailbox
    // is retried next tick.
    try {
      let cursor = mb.historyId
      if (cursor === null) {
        // Bootstrap: anchor at the profile's current historyId, then fire the
        // standard idempotent backfill so existing mail lands too. The stall
        // window is read BEFORE the cursor write (which bumps updatedAt).
        const bootstrap = await step.run(`${mb.id}:bootstrap-history`, async () => {
          const windowDays = await gapBackfillWindowDays(mb.address)
          const client = await createClientForAgent({
            agentId: mb.agentId,
            address: mb.address,
            purpose: 'gmail.sync',
            requestId,
          })
          const current = await client.getCurrentHistoryId()
          if (current) {
            await db.gmailMailbox.update({
              where: { id: mb.id },
              data: { historyId: current },
            })
          }
          return { current, windowDays }
        })
        cursor = bootstrap.current
        if (cursor === null) continue
        await step.run(`${mb.id}:bootstrap-backfill`, async () => {
          try {
            const res = await startBackfill(db, inngest, {
              provider: 'gmail',
              agentId: mb.agentId,
              windowDays: bootstrap.windowDays,
              ctx: { actorId: null, requestId },
            })
            return res.jobId
          } catch (err) {
            if (err instanceof BackfillAlreadyRunningError) return err.existingJobId
            throw err
          }
        })
      }
      const res = await syncMailboxHistory(
        step,
        {
          mailbox: mb,
          startHistoryId: cursor,
          requestId,
          keyPrefix: `${mb.id}:`,
        },
        logger,
      )
      processed += res.processed
      flagsMirrored += res.flagsMirrored
    } catch (err) {
      failed += 1
      logger.warn(
        { mailboxId: mb.id, address: mb.address, err },
        'gmail sync: mailbox failed — continuing with the remaining mailboxes',
      )
    }
  }

  const { healed, adopted } = await healEmailHeads(step, requestId, logger)

  // Full-mirror auto-deepening: keep walking each agent's history backwards
  // one 90-day chunk at a time until the horizon, so old mail reaches the
  // customer timelines without anyone pressing "Import history".
  const deepened = await step.run('deepen-history-mirror', async () => {
    try {
      return await autoDeepenGmailMirror(logger, requestId)
    } catch (err) {
      logger.warn({ err }, 'gmail auto-deepen failed — continuing')
      return { enqueued: 0, done: 0 }
    }
  })

  return {
    mailboxes: mailboxes.length,
    processed,
    flagsMirrored,
    healed,
    adopted,
    failed,
    deepened,
  }
}

export const gmailSyncMailboxes = inngest.createFunction(
  {
    id: 'gmail/sync',
    name: 'Poll Gmail for every connected mailbox (push-independent safety net)',
    // The function id is the lock — only one sweep at a time (like Trengo's
    // reconcile), so ticks never overlap and double-process.
    concurrency: { limit: 1 },
    retries: 2,
  },
  { cron: '*/10 * * * *' },
  async ({ runId, step, logger }) => {
    const res = await runFullGmailSync(step as unknown as StepRunner, runId, logger)
    logger.info(res, 'gmail/sync tick complete')
    return res
  },
)

export const gmailSyncNow = inngest.createFunction(
  {
    id: 'gmail/sync-now',
    name: 'Force a Gmail sync now (staff "Sync from Gmail" button)',
    concurrency: { limit: 1 },
    retries: 1,
  },
  { event: 'gmail/sync-now.requested' },
  async ({ runId, step, logger }) => {
    const res = await runFullGmailSync(step as unknown as StepRunner, runId, logger)
    logger.info(res, 'gmail/sync-now complete')
    return res
  },
)

// ADR 0017: 90-day historic backfill on first-connect.
import { BACKFILL_FUNCTIONS as GMAIL_BACKFILL_FUNCTIONS } from './backfill'
// On-demand retroactive resync of existing heads (flags + labels).
import { RESYNC_FUNCTIONS as GMAIL_RESYNC_FUNCTIONS } from './resync'

export const FUNCTIONS = [
  gmailHistoryChanged,
  gmailRefreshWatch,
  gmailSyncMailboxes,
  gmailSyncNow,
  ...GMAIL_BACKFILL_FUNCTIONS,
  ...GMAIL_RESYNC_FUNCTIONS,
] as const
