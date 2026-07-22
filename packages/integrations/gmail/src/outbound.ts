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

export interface OutboundAttachment {
  filename: string
  contentType: string
  /** Raw bytes — base64 encoding happens inside buildRawReply. */
  data: Buffer
}

export interface SendReplyInput {
  agentId: string
  /** The specific connected mailbox to send AS — selects that mailbox's own
   *  OAuth token. Omit for the agent's default mailbox. */
  fromAddress?: string | undefined
  threadId: string
  subject: string
  body: string
  /** Optional HTML alternative (multipart/alternative). */
  html?: string | undefined
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  /** OpenTelemetry trace id; idempotency key together with threadId. */
  requestId: string
  /** Original Message-ID header from the inbound thread, e.g. <abc@mail.gmail.com>. */
  originalMessageId?: string | undefined
  /** Optional file attachments — PDF, image, Excel, etc. Encoded as
   * base64 inside a multipart/mixed body when present. */
  attachments?: ReadonlyArray<OutboundAttachment>
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
function quotedFilename(name: string): string {
  // Strip CR/LF + quote so a malicious filename can't inject headers.
  return name.replace(/[\r\n"]/g, '_')
}

function base76(data: Buffer): string {
  // Gmail accepts base64 (RFC 2045) with 76-char line wraps. Build the
  // wrapped form ourselves so we don't rely on Node version specifics.
  const b = data.toString('base64')
  const lines: string[] = []
  for (let i = 0; i < b.length; i += 76) lines.push(b.slice(i, i + 76))
  return lines.join(CRLF)
}

function multipartBoundary(seed: string): string {
  // Random-ish but deterministic per call so tests can pass `seed` for
  // golden output. Production uses createId().
  return `==SMCRM_${seed.replace(/[^a-z0-9]/gi, '').slice(0, 24)}==`
}

function textPartBlock(boundary: string, text: string): string {
  return (
    `--${boundary}${CRLF}` +
    `Content-Type: text/plain; charset=UTF-8${CRLF}` +
    `Content-Transfer-Encoding: 8bit${CRLF}${CRLF}` +
    `${text}${CRLF}`
  )
}

function htmlPartBlock(boundary: string, html: string): string {
  return (
    `--${boundary}${CRLF}` +
    `Content-Type: text/html; charset=UTF-8${CRLF}` +
    `Content-Transfer-Encoding: 8bit${CRLF}${CRLF}` +
    `${html}${CRLF}`
  )
}

/** A multipart/alternative block (text + html) nested under `outerBoundary`. */
function alternativeBlock(
  outerBoundary: string,
  altBoundary: string,
  text: string,
  html: string,
): string {
  return (
    `--${outerBoundary}${CRLF}` +
    `Content-Type: multipart/alternative; boundary="${altBoundary}"${CRLF}${CRLF}` +
    textPartBlock(altBoundary, text) +
    htmlPartBlock(altBoundary, html) +
    `--${altBoundary}--${CRLF}`
  )
}

export function buildRawReply(input: {
  fromAddress?: string | undefined
  subject: string
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  body: string
  /** Optional HTML alternative — sent as multipart/alternative so the message
   *  renders rich (like Gmail) while plaintext clients still get `body`. */
  html?: string | undefined
  originalMessageId?: string | undefined
  attachments?: ReadonlyArray<OutboundAttachment>
  /** Deterministic boundary seed (tests). Defaults to a fresh id. */
  boundarySeed?: string
  /** When true, use the subject verbatim (a brand-new email, not a reply). */
  literalSubject?: boolean
}): { raw: string; subject: string; headers: Record<string, string> } {
  const subj = input.literalSubject
    ? input.subject.trim()
    : normaliseReplySubject(input.subject)
  const hasAttachments = (input.attachments?.length ?? 0) > 0
  const hasHtml = typeof input.html === 'string' && input.html.length > 0

  const headers: Record<string, string> = {
    'MIME-Version': '1.0',
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

  const seed = input.boundarySeed ?? createId()
  let body: string
  if (hasAttachments) {
    // multipart/mixed wrapping either an alternative block (text+html) or a
    // single text part, followed by the attachment parts.
    const boundary = multipartBoundary(seed)
    headers['Content-Type'] = `multipart/mixed; boundary="${boundary}"`
    const parts: string[] = []
    if (hasHtml) {
      parts.push(
        alternativeBlock(boundary, multipartBoundary(`${seed}alt`), input.body, input.html!),
      )
    } else {
      parts.push(textPartBlock(boundary, input.body))
    }
    for (const att of input.attachments!) {
      const name = quotedFilename(att.filename)
      parts.push(
        `--${boundary}${CRLF}` +
          `Content-Type: ${att.contentType}; name="${name}"${CRLF}` +
          `Content-Disposition: attachment; filename="${name}"${CRLF}` +
          `Content-Transfer-Encoding: base64${CRLF}${CRLF}` +
          `${base76(att.data)}${CRLF}`,
      )
    }
    parts.push(`--${boundary}--${CRLF}`)
    body = parts.join('')
  } else if (hasHtml) {
    // multipart/alternative: text + html, no attachments.
    const boundary = multipartBoundary(seed)
    headers['Content-Type'] = `multipart/alternative; boundary="${boundary}"`
    body =
      textPartBlock(boundary, input.body) +
      htmlPartBlock(boundary, input.html!) +
      `--${boundary}--${CRLF}`
  } else {
    headers['Content-Type'] = 'text/plain; charset=UTF-8'
    headers['Content-Transfer-Encoding'] = '8bit'
    body = input.body
  }

  const headerLines = Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join(CRLF)

  const message = headerLines + CRLF + CRLF + body
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

  // 3. Build the RFC 5322 raw message. Attachments (if any) become
  // multipart/mixed parts inside buildRawReply.
  const { raw } = buildRawReply({
    subject: input.subject,
    toAddresses: input.toAddresses,
    cc: input.cc,
    bcc: input.bcc,
    body: input.body,
    html: input.html,
    originalMessageId: input.originalMessageId,
    attachments: input.attachments,
  })

  // 4. Send — as the SPECIFIC mailbox (its own OAuth token), not the agent's
  //    default. Without `address`, a reply to a non-default connected inbox
  //    authenticates as the wrong account and Gmail 404s the foreign thread id.
  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.fromAddress,
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

export interface SendEmailInput {
  agentId: string
  /** Display From — Gmail sends as the authenticated user / send-as alias. */
  fromAddress?: string | undefined
  subject: string
  body: string
  /** Optional HTML alternative (multipart/alternative). */
  html?: string | undefined
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  /** OpenTelemetry trace id; the compose idempotency key. */
  requestId: string
  attachments?: ReadonlyArray<OutboundAttachment>
}

export interface SendEmailResult {
  outboundEmailIntentId: string
  gmailMessageId: string
  gmailThreadId: string
  status: 'sent'
  replayed: boolean
}

/**
 * Send a brand-new email (a fresh thread, not a reply). Mirrors `sendReply`:
 * persist intent → send → mark sent → link Contacts → audit. Idempotent on
 * `(threadId='compose:<requestId>', requestId)` since there is no thread id
 * until Gmail assigns one. The literal subject is used verbatim (no `Re:`).
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const idemThreadId = `compose:${input.requestId}`
  const existing = await db.outboundEmailIntent.findUnique({
    where: {
      threadId_requestId: { threadId: idemThreadId, requestId: input.requestId },
    },
    select: { id: true, status: true, gmailMessageId: true },
  })
  if (existing && existing.status === 'sent' && existing.gmailMessageId) {
    return {
      outboundEmailIntentId: existing.id,
      gmailMessageId: existing.gmailMessageId,
      gmailThreadId: '',
      status: 'sent',
      replayed: true,
    }
  }

  const intentId = existing?.id ?? createId()
  if (!existing) {
    await db.outboundEmailIntent.create({
      data: {
        id: intentId,
        agentId: input.agentId,
        threadId: idemThreadId,
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

  const { raw } = buildRawReply({
    subject: input.subject,
    toAddresses: input.toAddresses,
    cc: input.cc,
    bcc: input.bcc,
    body: input.body,
    html: input.html,
    fromAddress: input.fromAddress,
    attachments: input.attachments,
    literalSubject: true,
  })

  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.fromAddress,
    purpose: 'gmail.outbound_compose',
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

  await db.outboundEmailIntent.update({
    where: { id: intentId },
    data: { status: 'sent', gmailMessageId: sent.id, updatedById: input.agentId },
  })

  const recipients = Array.from(
    new Set(
      [...input.toAddresses, ...(input.cc ?? []), ...(input.bcc ?? [])].map((s) =>
        s.trim().toLowerCase(),
      ),
    ),
  )
  const contacts =
    recipients.length === 0
      ? []
      : await db.contact.findMany({
          where: { email: { in: recipients }, deletedAt: null },
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
            summary: `Email: ${input.subject}`.slice(0, 280),
            payload: {
              event: 'email.sent',
              gmailThreadId: sent.threadId,
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
      gmailThreadId: sent.threadId,
      gmailMessageId: sent.id,
      toAddresses: input.toAddresses,
      cc: input.cc ?? [],
      contactIds: contacts.map((c) => c.id),
    },
  })

  return {
    outboundEmailIntentId: intentId,
    gmailMessageId: sent.id,
    gmailThreadId: sent.threadId || '',
    status: 'sent',
    replayed: false,
  }
}

export interface OutboundContext {
  actorId: string
  requestId: string
}

// -----------------------------------------------------------------------------
// Drafts (G1–G3). Covered by the gmail.modify scope. `saveDraft` creates or
// updates a Gmail draft (auto-save); `sendDraftMessage` converts the draft to a
// sent message via drafts.send — Gmail guarantees no duplicate — then links
// Contacts + audits exactly like sendEmail.
// -----------------------------------------------------------------------------

export interface SaveDraftInput {
  agentId: string
  fromAddress?: string | undefined
  /** Existing Gmail draft id to update; omitted creates a new draft. */
  draftId?: string | undefined
  subject: string
  body: string
  html?: string | undefined
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  /** Thread to attach the draft to (reply drafts); omitted = new thread. */
  threadId?: string | undefined
  originalMessageId?: string | undefined
  requestId: string
}

export async function saveDraft(
  input: SaveDraftInput,
): Promise<{ draftId: string; messageId: string; threadId: string }> {
  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.fromAddress,
    purpose: 'gmail.draft_save',
    requestId: input.requestId,
  })
  const { raw } = buildRawReply({
    subject: input.subject,
    toAddresses: input.toAddresses,
    cc: input.cc,
    bcc: input.bcc,
    body: input.body,
    html: input.html,
    fromAddress: input.fromAddress,
    originalMessageId: input.originalMessageId,
    literalSubject: true,
  })
  return input.draftId
    ? client.updateDraft({ draftId: input.draftId, raw, threadId: input.threadId })
    : client.createDraft({ raw, threadId: input.threadId })
}

export interface SendDraftInput {
  agentId: string
  fromAddress?: string | undefined
  draftId: string
  subject: string
  toAddresses: string[]
  cc?: string[] | undefined
  bcc?: string[] | undefined
  requestId: string
}

export async function sendDraftMessage(input: SendDraftInput): Promise<SendEmailResult> {
  // Idempotent on (draft:<draftId>, requestId): a retry returns the prior send.
  const idemThreadId = `draft:${input.draftId}`
  const existing = await db.outboundEmailIntent.findUnique({
    where: { threadId_requestId: { threadId: idemThreadId, requestId: input.requestId } },
    select: { id: true, status: true, gmailMessageId: true },
  })
  if (existing && existing.status === 'sent' && existing.gmailMessageId) {
    return {
      outboundEmailIntentId: existing.id,
      gmailMessageId: existing.gmailMessageId,
      gmailThreadId: '',
      status: 'sent',
      replayed: true,
    }
  }
  const intentId = existing?.id ?? createId()
  if (!existing) {
    await db.outboundEmailIntent.create({
      data: {
        id: intentId,
        agentId: input.agentId,
        threadId: idemThreadId,
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

  const client = await createClientForAgent({
    agentId: input.agentId,
    address: input.fromAddress,
    purpose: 'gmail.draft_send',
    requestId: input.requestId,
  })
  let sent
  try {
    sent = await client.sendDraft(input.draftId)
  } catch (err) {
    await db.outboundEmailIntent.update({
      where: { id: intentId },
      data: { status: 'failed', updatedById: input.agentId },
    })
    throw err
  }

  await db.outboundEmailIntent.update({
    where: { id: intentId },
    data: { status: 'sent', gmailMessageId: sent.id, updatedById: input.agentId },
  })

  const recipients = Array.from(
    new Set(
      [...input.toAddresses, ...(input.cc ?? []), ...(input.bcc ?? [])].map((s) =>
        s.trim().toLowerCase(),
      ),
    ),
  )
  const contacts =
    recipients.length === 0
      ? []
      : await db.contact.findMany({
          where: {
            OR: recipients.map((a) => ({ email: { equals: a, mode: 'insensitive' as const } })),
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
            summary: `Email: ${input.subject}`.slice(0, 280),
            payload: {
              event: 'email.sent',
              threadId: sent.threadId,
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
      via: 'draft',
      draftId: input.draftId,
      gmailMessageId: sent.id,
      toAddresses: input.toAddresses,
      contactIds: contacts.map((c) => c.id),
    },
  })

  return {
    outboundEmailIntentId: intentId,
    gmailMessageId: sent.id,
    gmailThreadId: sent.threadId || '',
    status: 'sent',
    replayed: false,
  }
}
