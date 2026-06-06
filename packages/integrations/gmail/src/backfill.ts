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
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

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
    name: 'Backfill last 90 days of Gmail history for an agent',
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
    let pageToken: string | undefined
    const query = `after:${ymd(new Date(windowFrom))} before:${ymd(
      new Date(new Date(windowTo).getTime() + 24 * 60 * 60 * 1000),
    )}`

    try {
      const mailbox = await step.run('load-mailbox', async () =>
        db.gmailMailbox.findFirst({
          where: { agentId, deletedAt: null },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
          select: { address: true },
        }),
      )
      const agentAddr = mailbox?.address.toLowerCase() ?? ''

      do {
        const { ids, nextPageToken } = await step.run(
          `list-page-${pageToken ?? 'first'}`,
          async () => {
            const client = await createClientForAgent({
              agentId,
              purpose: 'gmail.backfill',
              requestId: jobId,
            })
            return listMessageIds(client.agentId, query, pageToken)
          },
        )

        for (const messageId of ids) {
          try {
            const result = await step.run(`message-${messageId}`, async () =>
              processBackfillMessage({ agentId, messageId, agentAddr, requestId: jobId }),
            )
            processed += 1
            if (result.matched > 0) matched += result.matched
            else skipped += 1
          } catch (err) {
            // One unreadable/oddly-shaped message must not abort the whole
            // import. Skip it and keep going so the rest of the mailbox lands.
            processed += 1
            skipped += 1
            logger.warn({ jobId, messageId, err }, 'gmail backfill: skipped a message that failed to import')
          }
        }
        await step.run(`progress-${pageToken ?? 'first'}`, async () =>
          incrementBackfillProgress(db, jobId, {
            processed,
            matched,
            skipped,
            lastEventId: ids[ids.length - 1] ?? null,
          }),
        )
        pageToken = nextPageToken ?? undefined
      } while (pageToken)

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
  query: string,
  pageToken: string | undefined,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
  const wrappedClient = await createClientForAgent({
    agentId,
    purpose: 'gmail.backfill',
  })
  void wrappedClient // We only need the OAuth setup as a side-effect; we re-derive auth below for the raw call.
  // Re-derive a raw client so we can call users.messages.list directly.
  // The token decryption inside createClientForAgent has already happened —
  // here we issue a parallel call with the same env credentials.
  const user = await db.user.findUnique({
    where: { id: agentId },
    select: { gmailRefreshTokenCipherId: true },
  })
  if (!user?.gmailRefreshTokenCipherId) return { ids: [], nextPageToken: null }

  // Build a thin gmail client straight from googleapis — same auth path as
  // createClientForAgent but exposing `messages.list`.
  const { decryptFieldById } = await import('@studymind/core/safeguarding')
  const refreshToken = await decryptFieldById(db, {
    encryptedFieldId: user.gmailRefreshTokenCipherId,
    actorId: agentId,
    purpose: 'gmail.backfill',
  })
  const oauth2 = new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
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
  if (matchedContacts.length === 0) return { matched: 0 }

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

  for (const contact of matchedContacts) {
    await db.interaction.create({
      data: {
        id: createId(),
        type: dbType,
        contactId: contact.id,
        occurredAt,
        summary: subject.slice(0, 280),
        payload: {
          event: eventName,
          backfill: true,
          gmailMessageId: message.id,
          gmailThreadId: message.threadId,
          messageIdHeader,
          from: fromAddrs,
          to: toAddrs,
          cc: ccAddrs,
          bcc: bccAddrs,
          matchedVia: contact.email,
          subject,
          attachments: attachmentRefs,
        },
      },
    })
  }
  return { matched: matchedContacts.length }
}

export const BACKFILL_FUNCTIONS = [gmailBackfillRequested] as const
