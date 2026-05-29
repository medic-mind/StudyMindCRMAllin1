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
import { db } from '@studymind/db'
import { inngest } from '@studymind/jobs'

import {
  createClientForAgent,
  isInvalidGrantError,
  markNeedsReconnect,
  getHeader,
  parseAddresses,
  type GmailMessage,
} from './client'
import { putAttachment } from './s3'

interface HistoryChangedData {
  eventId: string
  providerEventRowId: string
  emailAddress: string
  historyId: string
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
        select: { agentId: true, historyId: true },
      }),
    )
    if (!mailbox) {
      logger.warn({ eventId, emailAddress }, 'gmail mailbox not found — skip')
      await step.run('mark-processed', async () => markProcessed(providerEventRowId))
      return { skipped: true }
    }

    const startHistoryId = mailbox.historyId ?? historyId
    let result
    try {
      result = await step.run('list-history', async () => {
        const client = await createClientForAgent({
          agentId: mailbox.agentId,
          purpose: 'gmail.sync',
          requestId: eventId,
        })
        return client.listHistorySince(startHistoryId)
      })
    } catch (err) {
      if (isInvalidGrantError(err)) {
        logger.warn(
          { eventId, agentId: mailbox.agentId, requestId: eventId },
          'gmail refresh token rejected (invalid_grant) — marking needs_reconnect',
        )
        await step.run('mark-needs-reconnect', async () =>
          markNeedsReconnect(mailbox.agentId),
        )
        await step.run('audit-needs-reconnect', async () =>
          writeAuditLogEntry(db, {
            actorId: null,
            action: 'gmail.oauth_needs_reconnect',
            target: { type: 'User', id: mailbox.agentId },
            requestId: eventId,
          }),
        )
        await step.run('mark-processed', async () => markProcessed(providerEventRowId))
        return { skipped: true, reason: 'needs_reconnect' as const }
      }
      throw err
    }

    for (const added of result.added) {
      // Per-message step lets a single bad message land in DLQ rather than
      // poisoning the whole history sync.
      await step.run(`process-${added.messageId}`, async () =>
        processMessage({
          agentId: mailbox.agentId,
          messageId: added.messageId,
          requestId: eventId,
        }),
      )
    }

    await step.run('advance-history', async () =>
      db.gmailMailbox.update({
        where: { address: emailAddress },
        data: { historyId: result.newHistoryId },
      }),
    )

    await step.run('mark-processed', async () => markProcessed(providerEventRowId))
    return { ok: true, processed: result.added.length, historyId: result.newHistoryId }
  },
)

interface ProcessMessageInput {
  agentId: string
  messageId: string
  requestId: string
}

async function processMessage(input: ProcessMessageInput): Promise<void> {
  // Idempotent on Gmail message id (CLAUDE.md §14).
  const existing = await db.interaction.findFirst({
    where: { payload: { path: ['gmailMessageId'], equals: input.messageId } },
    select: { id: true },
  })
  if (existing) return

  const client = await createClientForAgent({
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

  // Match Contacts by every address (many-to-many — §14).
  const allAddrs = Array.from(
    new Set([...fromAddrs, ...toAddrs, ...ccAddrs, ...bccAddrs]),
  ).filter((a) => !agentAddrs.includes(a))
  const matchedContacts = await db.contact.findMany({
    where: { email: { in: allAddrs }, deletedAt: null },
    select: { id: true, email: true },
  })

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
    return
  }

  for (const contact of matchedContacts) {
    const created = await db.interaction.create({
      data: {
        id: createId(),
        type: dbType,
        contactId: contact.id,
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

// ADR 0017: 90-day historic backfill on first-connect.
import { BACKFILL_FUNCTIONS as GMAIL_BACKFILL_FUNCTIONS } from './backfill'

export const FUNCTIONS = [
  gmailHistoryChanged,
  gmailRefreshWatch,
  ...GMAIL_BACKFILL_FUNCTIONS,
] as const
