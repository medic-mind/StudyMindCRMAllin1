// Outbound calls TO Gmail. CLAUDE.md §14.
//
// Sends a reply on an existing Gmail thread on behalf of an agent. The flow:
//   1. Look up (threadId, requestId) idempotency key. If a previous send
//      already succeeded, return its OutboundEmailIntent + gmailMessageId.
//   2. Build an RFC 5322 message with In-Reply-To / References headers
//      preserved on the original message id, base64url-encoded into the
//      Gmail SDK `raw` field.
//   3. Persist OutboundEmailIntent in `pending` BEFORE the Gmail call.
//   4. Call gmail.users.messages.send.
//   5. On success, mark intent `sent`, write an Interaction of type
//      `email_sent` linked to all matched Contacts, and audit.

import { createId } from '@paralleldrive/cuid2'

import { writeAuditLogEntry } from '@studymind/audit'
import { db } from '@studymind/db'

import { createClientForAgent } from './client'

export interface SendReplyInput {
  agentId: string
  threadId: string
  subject: string
  body: string
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  /** OpenTelemetry trace id; idempotency key together with threadId. */
  requestId: string
  /** Original Message-ID header from the inbound thread, e.g. <abc@mail.gmail.com>. */
  originalMessageId?: string | undefined
  /** Override gmail SDK construction (tests). */
  factory?: () => Parameters<typeof createClientForAgent>[0]['factory'] extends infer F
    ? F
    : never
}

export interface SendReplyResult {
  outboundEmailIntentId: string
  gmailMessageId: string
  gmailThreadId: string
  status: 'sent'
  /** True when an existing successful send was returned via idempotency. */
  replayed: boolean
}

const CRLF = '\r\n'

/**
 * Build an RFC 5322 message and base64url-encode it for the Gmail SDK
 * `users.messages.send` call. Subject is normalised so we never produce
 * `Re: Re: Re:` chains; threading headers reference the prior message id.
 *
 * Exported for unit testing.
 */
export function buildRawReply(input: {
  fromAddress?: string | undefined
  subject: string
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  body: string
  originalMessageId?: string | undefined
}): { raw: string; subject: string; headers: Record<string, string> } {
  const subj = normaliseReplySubject(input.subject)
  const headers: Record<string, string> = {
    'MIME-Version': '1.0',
    'Content-Type': 'text/plain; charset=UTF-8',
    'Content-Transfer-Encoding': '8bit',
    To: input.toAddresses.join(', '),
    Subject: subj,
  }
  if (input.fromAddress) headers['From'] = input.fromAddress
  if (input.cc && input.cc.length > 0) headers['Cc'] = input.cc.join(', ')
  if (input.bcc && input.bcc.length > 0) headers['Bcc'] = input.bcc.join(', ')
  if (input.originalMessageId) {
    headers['In-Reply-To'] = input.originalMessageId
    headers['References'] = input.originalMessageId
  }

  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(CRLF)

  const message = headerLines + CRLF + CRLF + input.body
  const raw = Buffer.from(message, 'utf8').toString('base64url')
  return { raw, subject: subj, headers }
}

function normaliseReplySubject(subject: string): string {
  // Trim, collapse multiple `Re:` prefixes, then add a single one.
  const stripped = subject.replace(/^(\s*re:\s*)+/i, '').trim()
  return `Re: ${stripped}`
}

export async function sendReply(input: SendReplyInput): Promise<SendReplyResult> {
  // 1. Idempotency: same (threadId, requestId) returns the existing row.
  const existing = await db.outboundEmailIntent.findUnique({
    where: {
      threadId_requestId: {
        threadId: input.threadId,
        requestId: input.requestId,
      },
    },
    select: {
      id: true,
      status: true,
      gmailMessageId: true,
      threadId: true,
    },
  })
  if (existing && existing.status === 'sent' && existing.gmailMessageId) {
    return {
      outboundEmailIntentId: existing.id,
      gmailMessageId: existing.gmailMessageId,
      gmailThreadId: existing.threadId,
      status: 'sent',
      replayed: true,
    }
  }

  // 2. Persist intent BEFORE the Gmail call.
  const intentId = existing?.id ?? createId()
  if (!existing) {
    await db.outboundEmailIntent.create({
      data: {
        id: intentId,
        agentId: input.agentId,
        threadId: input.threadId,
        requestId: input.requestId,
        subject: input.subject,
        toAddresses: input.toAddresses,
        ccAddresses: input.cc ?? [],
        bccAddresses: input.bcc ?? [],
        status: 'pending',
        createdById: input.agentId,
        updatedById: input.agentId,
      },
    })
  }

  // 3. Build the RFC 5322 raw message.
  const { raw } = buildRawReply({
    subject: input.subject,
    toAddresses: input.toAddresses,
    cc: input.cc,
    bcc: input.bcc,
    body: input.body,
    originalMessageId: input.originalMessageId,
  })

  // 4. Send.
  const client = await createClientForAgent({
    agentId: input.agentId,
    purpose: 'gmail.outbound_reply',
    requestId: input.requestId,
  })
  let sent
  try {
    sent = await client.sendMessage({ raw })
  } catch (err) {
    await db.outboundEmailIntent.update({
      where: { id: intentId },
      data: { status: 'failed', updatedById: input.agentId },
    })
    throw err
  }

  // 5. Mark sent, link Contacts, audit.
  await db.outboundEmailIntent.update({
    where: { id: intentId },
    data: {
      status: 'sent',
      gmailMessageId: sent.id,
      updatedById: input.agentId,
    },
  })

  // Match Contacts by every address on the envelope. CLAUDE.md §14: many-to-
  // many; one outbound email may touch several Contacts (parents, students,
  // LA caseworkers). We persist one Interaction per matched Contact so each
  // timeline shows the thread regardless of which address was matched.
  const recipientSet = new Set(
    [
      ...input.toAddresses,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ].map((s) => s.trim().toLowerCase()),
  )
  const recipients = Array.from(recipientSet)
  const contacts =
    recipients.length === 0
      ? []
      : await db.contact.findMany({
          where: {
            email: { in: recipients },
            deletedAt: null,
          },
          select: { id: true, email: true },
        })

  if (contacts.length > 0) {
    await db.$transaction(
      contacts.map((c) =>
        db.interaction.create({
          data: {
            id: createId(),
            type: 'email_sent',
            contactId: c.id,
            occurredAt: new Date(),
            summary: `Reply: ${input.subject}`,
            payload: {
              event: 'email.sent',
              threadId: input.threadId,
              gmailMessageId: sent.id,
              toAddresses: input.toAddresses,
              cc: input.cc ?? [],
              outboundEmailIntentId: intentId,
            },
            createdById: input.agentId,
            updatedById: input.agentId,
          },
        }),
      ),
    )
  }

  await writeAuditLogEntry(db, {
    actorId: input.agentId,
    action: 'gmail.email_sent',
    target: { type: 'OutboundEmailIntent', id: intentId },
    requestId: input.requestId,
    after: {
      threadId: input.threadId,
      gmailMessageId: sent.id,
      toAddresses: input.toAddresses,
      cc: input.cc ?? [],
      contactIds: contacts.map((c) => c.id),
    },
  })

  return {
    outboundEmailIntentId: intentId,
    gmailMessageId: sent.id,
    gmailThreadId: sent.threadId || input.threadId,
    status: 'sent',
    replayed: false,
  }
}

export interface OutboundContext {
  actorId: string
  requestId: string
}

export async function ping(_ctx: OutboundContext): Promise<void> {
  throw new Error('not implemented')
}
