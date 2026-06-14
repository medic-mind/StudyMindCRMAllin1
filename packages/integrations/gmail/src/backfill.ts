// Gmail 90-day historic backfill worker (ADR 0017).
//
// Triggered by the OAuth callback (and by the admin "Backfill last 90 days"
// button). Walks `users.messages.list` with `q: 'after:YYYY/MM/DD'` and
// `before:YYYY/MM/DD`, refetches each message in full, matches recipients to
// existing Contacts by from/to/cc/bcc, and persists one
// email_received/email_sent Interaction per matched Contact. Skips messages
// with no Contact match (per the task brief — backfill must not create
// ghost Contacts).
//
// Idempotent on Gmail message id: a re-run checks for an existing
// Interaction with the same `payload.gmailMessageId` before writing.
//
// Progress is reported every batch via incrementBackfillProgress; one final
// summary AuditLogEntry is written by markBackfillCompleted (CLAUDE.md §17:
// no per-message audit during backfill).

import { createId } from '@paralleldrive/cuid2'
import { google } from 'googleapis'

import {
  incrementBackfillProgress,
  markBackfillCompleted,
  markBackfillFailed,
  markBackfillRunning,
} from '@studymind/core/backfill'
import { applyMailToConversation, prepareEmailHtml } from '@studymind/core/mail'
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import { primaryAccountByContact } from './business-account-link'
import {
  createClientForAgent,
  getHeader,
  isInvalidGrantError,
  parseAddresses,
  type GmailMessage,
} from './client'
import { putAttachment } from './s3'

interface BackfillRequestedData {
  jobId: string
  provider: 'gmail'
  agentId: string | null
  windowFrom: string // ISO
  windowTo: string // ISO
}

function ymd(date: Date): string {
  // Gmail's `after:` filter takes YYYY/MM/DD.
  const y = date.getUTCFullYear()
  const m = String(date.getUTCMonth() + 1).padStart(2, '0')
  const d = String(date.getUTCDate()).padStart(2, '0')
  return `${y}/${m}/${d}`
}

export const gmailBackfillRequested = inngest.createFunction(
  {
    id: 'gmail/backfill.requested',
    name: 'Backfill Gmail history for an agent (windowed)',
    concurrency: { limit: 2 },
    retries: 4,
  },
  { event: 'backfill/gmail.requested' },
  async ({ event, step, logger }) => {
    const data = event.data as BackfillRequestedData
    const { jobId, agentId, windowFrom, windowTo } = data
    if (!agentId) {
      await markBackfillFailed(db, jobId, 'gmail backfill requires agentId', jobId)
      return { skipped: true, reason: 'no_agent_id' }
    }

    await step.run('mark-running', async () => markBackfillRunning(db, jobId))

    let processed = 0
    let matched = 0
    let skipped = 0
    const query = `after:${ymd(new Date(windowFrom))} before:${ymd(
      new Date(new Date(windowTo).getTime() + 24 * 60 * 60 * 1000),
    )}`

    try {
      // Walk EVERY connected mailbox for this agent, each with its OWN token
      // (multi-account). A single backfill job covers all connected accounts.
      const mailboxes = await step.run('load-mailboxes', async () =>
        db.gmailMailbox.findMany({
          where: { agentId, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { id: true, address: true },
        }),
      )

      for (const mb of mailboxes) {
        const agentAddr = mb.address.toLowerCase()
        let pageToken: string | undefined
        do {
          const { ids, nextPageToken } = await step.run(
            `list-${mb.id}-${pageToken ?? 'first'}`,
            async () => listMessageIds(agentId, mb.address, query, pageToken),
          )

          for (const messageId of ids) {
            try {
              const result = await step.run(`message-${mb.id}-${messageId}`, async () =>
                processBackfillMessage({
                  agentId,
                  mailboxId: mb.id,
                  address: mb.address,
                  agentAddr,
                  messageId,
                  requestId: jobId,
                }),
              )
              processed += 1
              if (result.matched > 0) matched += result.matched
              else skipped += 1
            } catch (err) {
              // One unreadable/oddly-shaped message must not abort the whole
              // import. Skip it and keep going so the rest of the mailbox lands.
              processed += 1
              skipped += 1
              logger.warn(
                { jobId, messageId, err },
                'gmail backfill: skipped a message that failed to import',
              )
            }
          }
          await step.run(`progress-${mb.id}-${pageToken ?? 'first'}`, async () =>
            incrementBackfillProgress(db, jobId, {
              processed,
              matched,
              skipped,
              lastEventId: ids[ids.length - 1] ?? null,
            }),
          )
          pageToken = nextPageToken ?? undefined
        } while (pageToken)
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
      const message =
        err instanceof Error
          ? isInvalidGrantError(err)
            ? `gmail token rejected: ${err.message}`
            : err.message
          : 'unknown error'
      logger.error({ jobId, agentId, err }, 'gmail backfill failed')
      await markBackfillFailed(db, jobId, message, jobId)
      throw err
    }
  },
)

// Helper that uses the raw googleapis client to list message ids. We do this
// rather than adding to the GmailClient interface so the surface stays
// minimal — the list endpoint is only used by backfill.
async function listMessageIds(
  agentId: string,
  address: string,
  query: string,
  pageToken: string | undefined,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  // Resolve THIS mailbox's own token (multi-account); fall back to the agent's
  // default User token for rows connected before per-mailbox tokens existed.
  const mailbox = await db.gmailMailbox.findUnique({
    where: { address },
    select: { refreshTokenCipherId: true },
  })
  let cipherId = mailbox?.refreshTokenCipherId ?? null
  if (!cipherId) {
    const user = await db.user.findUnique({
      where: { id: agentId },
      select: { gmailRefreshTokenCipherId: true },
    })
    cipherId = user?.gmailRefreshTokenCipherId ?? null
  }
  if (!cipherId) return { ids: [], nextPageToken: null }

  // Build a thin gmail client straight from googleapis — same auth path as
  // createClientForAgent but exposing `messages.list`.
  const { decryptFieldById } = await import('@studymind/core/safeguarding')
  const refreshToken = await decryptFieldById(db, {
    encryptedFieldId: cipherId,
    actorId: agentId,
    purpose: 'gmail.backfill',
  })
  // Same OAuth client the connect/refresh path uses (prefer the GOOGLE_OAUTH_*
  // names, fall back to the legacy GOOGLE_* ones) so the refresh token resolves
  // against the client that minted it — otherwise the list call 401s.
  const oauth2 = new google.auth.OAuth2(
    process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? process.env['GOOGLE_CLIENT_SECRET'],
  )
  oauth2.setCredentials({ refresh_token: refreshToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 100,
    pageToken: pageToken ?? undefined,
  })
  const ids = (res.data.messages ?? [])
    .map((m) => m.id)
    .filter((id): id is string => !!id)
  return { ids, nextPageToken: res.data.nextPageToken ?? null }
}

interface ProcessInput {
  agentId: string
  /** GmailMailbox.id — resolves the owning MailAccount for the head. */
  mailboxId: string
  /** Mailbox address to act as (its own token — multi-account). */
  address: string
  messageId: string
  agentAddr: string
  requestId: string
}

async function processBackfillMessage(
  input: ProcessInput,
): Promise<{ matched: number }> {
  // Idempotent on Gmail message id.
  const existing = await db.interaction.findFirst({
    where: { payload: { path: ['gmailMessageId'], equals: input.messageId } },
    select: { id: true },
  })
  if (existing) return { matched: 0 }

  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.address,
    purpose: 'gmail.backfill',
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

  const direction = fromAddrs.includes(input.agentAddr) ? 'sent' : 'received'
  const allAddrs = Array.from(
    new Set([...fromAddrs, ...toAddrs, ...ccAddrs, ...bccAddrs]),
  ).filter((a) => a !== input.agentAddr)

  const matchedContacts = await db.contact.findMany({
    where: { email: { in: allAddrs }, deletedAt: null },
    select: { id: true, email: true },
  })
  const accountByContact =
    matchedContacts.length > 0
      ? await primaryAccountByContact(matchedContacts.map((c) => c.id))
      : new Map<string, string>()

  // Stream attachments to S3 (same behaviour as live sync).
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
  const dbType = direction === 'sent' ? 'email_sent' : 'email_received'
  const eventName = direction === 'sent' ? 'email.sent' : 'email.received'
  // Parity with the live sync: capture the rich HTML body for the reading pane.
  const bodyHtml = prepareEmailHtml(message.htmlBody)
  const basePayload = {
    event: eventName,
    backfill: true,
    gmailMessageId: message.id,
    gmailThreadId: message.threadId,
    messageIdHeader,
    from: fromAddrs,
    to: toAddrs,
    cc: ccAddrs,
    bcc: bccAddrs,
    subject,
    bodyHtml,
    attachments: attachmentRefs,
  }

  // Unmatched mail is still recorded (contactId null — never a ghost contact,
  // §14) so it shows in /mail; matched mail gets one row per contact + the B2B
  // account stamp.
  if (matchedContacts.length === 0) {
    await db.interaction.create({
      data: {
        id: createId(),
        type: dbType,
        contactId: null,
        occurredAt,
        summary: subject.slice(0, 280),
        payload: basePayload,
      },
    })
  } else {
    for (const contact of matchedContacts) {
      await db.interaction.create({
        data: {
          id: createId(),
          type: dbType,
          contactId: contact.id,
          businessAccountId: accountByContact.get(contact.id) ?? null,
          occurredAt,
          summary: subject.slice(0, 280),
          payload: { ...basePayload, matchedVia: contact.email },
        },
      })
    }
  }

  // Upsert the email Conversation head so the thread shows in /mail + the Comms
  // Centre — parity with the live sync (which the backfill previously skipped,
  // leaving /mail empty after a connect+import).
  const account = await db.mailAccount.findFirst({
    where: { gmailMailboxId: input.mailboxId, deletedAt: null },
    select: { id: true },
  })
  await applyMailToConversation(db, {
    provider: 'email',
    externalThreadId: message.threadId,
    mailAccountId: account?.id ?? null,
    direction,
    occurredAt,
    contactId: matchedContacts[0]?.id ?? null,
    familyId: null,
    subject: subject || null,
  })

  return { matched: matchedContacts.length }
}

export const BACKFILL_FUNCTIONS = [gmailBackfillRequested] as const
