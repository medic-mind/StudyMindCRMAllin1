// Per-agent Gmail client. CLAUDE.md §14.
//
// Each agent connects their own Gmail via OAuth. Refresh tokens are
// KMS-encrypted in `GmailToken` and decrypted just-in-time here. Granular
// scopes only — gmail.readonly, gmail.modify, gmail.send. The returned
// client is request-scoped and MUST NOT be cached across users.

import { google, type gmail_v1 } from 'googleapis'

import { decryptField } from '@studymind/core/safeguarding'
import { db } from '@studymind/db'

export interface GmailMessageRef {
  id: string
  threadId: string
}

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailAttachmentMeta {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface GmailMessage {
  id: string
  threadId: string
  internalDate: number
  headers: GmailHeader[]
  /** Best-effort plain text body (gmail.utils unwraps base64url multiparts). */
  body: string
  attachments: GmailAttachmentMeta[]
}

export interface GmailHistoryAddedMessage {
  messageId: string
  threadId: string
}

export interface GmailHistoryResult {
  /** History entries with messagesAdded only — sufficient for our sync. */
  added: GmailHistoryAddedMessage[]
  /** Use as the next startHistoryId. */
  newHistoryId: string
}

export interface GmailWatchResult {
  historyId: string
  expirationMs: number
}

export interface GmailClient {
  readonly agentId: string
  getMessage(messageId: string): Promise<GmailMessage>
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>
  sendMessage(input: { raw: string }): Promise<GmailMessageRef>
  setupWatch(input: { topicName: string }): Promise<GmailWatchResult>
  stopWatch(): Promise<void>
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>
}

export interface CreateGmailClientOptions {
  agentId: string
  /** Override decrypted refresh token (tests). */
  refreshToken?: string
  /** Audit/correlation context for the decryption call. */
  purpose?: string
  requestId?: string
  /** Replace the gmail SDK constructor (tests). */
  factory?: () => gmail_v1.Gmail
}

export async function createClientForAgent(
  opts: CreateGmailClientOptions,
): Promise<GmailClient> {
  if (opts.factory) {
    return wrap(opts.agentId, opts.factory())
  }

  let refreshToken = opts.refreshToken
  if (!refreshToken) {
    const row = await db.gmailToken.findUnique({
      where: { agentId: opts.agentId },
      select: {
        tokenCiphertext: true,
        tokenIv: true,
        dekCiphertext: true,
        aad: true,
        keyVersion: true,
        deletedAt: true,
      },
    })
    if (!row || row.deletedAt) {
      throw new Error(`No Gmail token registered for agent ${opts.agentId}`)
    }
    refreshToken = await decryptField(
      {
        ciphertext: row.tokenCiphertext,
        iv: row.tokenIv,
        dekCiphertext: row.dekCiphertext,
        aad: row.aad,
        keyVersion: row.keyVersion,
      },
      {
        actorId: opts.agentId,
        purpose: opts.purpose ?? 'gmail.sync',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      },
    )
  }

  const oauth2 = new google.auth.OAuth2(
    process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_CLIENT_SECRET'],
  )
  oauth2.setCredentials({ refresh_token: refreshToken })
  const gmail = google.gmail({ version: 'v1', auth: oauth2 })
  return wrap(opts.agentId, gmail)
}

// Backwards-compat alias used by jobs and outbound modules.
export const createClient = createClientForAgent

function wrap(agentId: string, gmail: gmail_v1.Gmail): GmailClient {
  return {
    agentId,
    async getMessage(messageId) {
      const res = await gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      })
      return normaliseMessage(res.data)
    },
    async listHistorySince(startHistoryId) {
      const res = await gmail.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['messageAdded'],
      })
      const added: GmailHistoryAddedMessage[] = []
      for (const h of res.data.history ?? []) {
        for (const m of h.messagesAdded ?? []) {
          if (m.message?.id && m.message.threadId) {
            added.push({ messageId: m.message.id, threadId: m.message.threadId })
          }
        }
      }
      return {
        added,
        newHistoryId: res.data.historyId ?? startHistoryId,
      }
    },
    async sendMessage(input) {
      const res = await gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: input.raw },
      })
      return { id: res.data.id ?? '', threadId: res.data.threadId ?? '' }
    },
    async setupWatch(input) {
      const res = await gmail.users.watch({
        userId: 'me',
        requestBody: { topicName: input.topicName },
      })
      return {
        historyId: res.data.historyId ?? '',
        expirationMs: Number(res.data.expiration ?? 0),
      }
    },
    async stopWatch() {
      await gmail.users.stop({ userId: 'me' })
    },
    async getAttachment(messageId, attachmentId) {
      const res = await gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      })
      const data = res.data.data ?? ''
      return Buffer.from(data, 'base64url')
    },
  }
}

// -----------------------------------------------------------------------------
// Message normaliser — pulls out headers, plaintext body, attachment meta.
// -----------------------------------------------------------------------------

export function normaliseMessage(raw: gmail_v1.Schema$Message): GmailMessage {
  const headers: GmailHeader[] = (raw.payload?.headers ?? []).map((h) => ({
    name: h.name ?? '',
    value: h.value ?? '',
  }))
  const attachments: GmailAttachmentMeta[] = []
  let body = ''

  function visit(part: gmail_v1.Schema$MessagePart | undefined): void {
    if (!part) return
    if (part.filename && part.body?.attachmentId) {
      attachments.push({
        attachmentId: part.body.attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        sizeBytes: Number(part.body.size ?? 0),
      })
      return
    }
    if (part.mimeType === 'text/plain' && part.body?.data && !body) {
      body = Buffer.from(part.body.data, 'base64url').toString('utf8')
    }
    for (const child of part.parts ?? []) visit(child)
  }

  visit(raw.payload ?? undefined)
  if (!body && raw.payload?.body?.data) {
    body = Buffer.from(raw.payload.body.data, 'base64url').toString('utf8')
  }

  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    internalDate: Number(raw.internalDate ?? 0),
    headers,
    body,
    attachments,
  }
}

export function getHeader(headers: GmailHeader[], name: string): string | null {
  const lower = name.toLowerCase()
  const found = headers.find((h) => h.name.toLowerCase() === lower)
  return found?.value ?? null
}

export function parseAddresses(value: string | null): string[] {
  if (!value) return []
  // RFC 2822 "Name <a@b.com>, b@c.com" — simple splitter, lowercased.
  return value
    .split(',')
    .map((s) => {
      const m = s.match(/<([^>]+)>/)
      const addr = m && m[1] ? m[1] : s
      return addr.trim().toLowerCase()
    })
    .filter((s) => s.length > 0 && s.includes('@'))
}
