// Per-agent Gmail client. CLAUDE.md §14, ADR 0012.
//
// Each agent connects their own Gmail via OAuth. Refresh tokens live as
// `EncryptedField` rows pointed at by `User.gmailRefreshTokenCipherId`
// (ADR 0012). For older rows that landed in the legacy `GmailToken` table
// before the ADR, we still fall back so the migration is a no-op. Granular
// scopes only — gmail.readonly, gmail.modify, gmail.send. The returned
// client is request-scoped and MUST NOT be cached across users.

import { createId } from '@paralleldrive/cuid2'
import { google, type gmail_v1 } from 'googleapis'

import { decryptFieldById, decryptField } from '@studymind/core/safeguarding'
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

export interface GmailLabelRef {
  id: string
  name: string
}

export interface GmailClient {
  readonly agentId: string
  getMessage(messageId: string): Promise<GmailMessage>
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>
  sendMessage(input: { raw: string }): Promise<GmailMessageRef>
  setupWatch(input: { topicName: string }): Promise<GmailWatchResult>
  stopWatch(): Promise<void>
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>
  // ADR 0021 Phase 5 — two-way action sync. All idempotent: adding/removing a
  // label already in the desired state is a Gmail no-op.
  modifyThread(input: {
    threadId: string
    addLabelIds?: string[]
    removeLabelIds?: string[]
  }): Promise<void>
  trashThread(threadId: string): Promise<void>
  untrashThread(threadId: string): Promise<void>
  listLabels(): Promise<GmailLabelRef[]>
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
    // ADR 0012: prefer the EncryptedField pointer on User.
    const user = await db.user.findUnique({
      where: { id: opts.agentId },
      select: { gmailRefreshTokenCipherId: true },
    })
    if (user?.gmailRefreshTokenCipherId) {
      refreshToken = await decryptFieldById(db, {
        encryptedFieldId: user.gmailRefreshTokenCipherId,
        actorId: opts.agentId,
        purpose: opts.purpose ?? 'gmail.sync',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      })
    } else {
      // Legacy fallback for any pre-ADR-0012 rows still living in GmailToken.
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
    async modifyThread(input) {
      await gmail.users.threads.modify({
        userId: 'me',
        id: input.threadId,
        requestBody: {
          addLabelIds: input.addLabelIds ?? [],
          removeLabelIds: input.removeLabelIds ?? [],
        },
      })
    },
    async trashThread(threadId) {
      await gmail.users.threads.trash({ userId: 'me', id: threadId })
    },
    async untrashThread(threadId) {
      await gmail.users.threads.untrash({ userId: 'me', id: threadId })
    },
    async listLabels() {
      const res = await gmail.users.labels.list({ userId: 'me' })
      return (res.data.labels ?? [])
        .filter((l): l is { id: string; name: string } => !!l.id && !!l.name)
        .map((l) => ({ id: l.id, name: l.name }))
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

// -----------------------------------------------------------------------------
// Per-user watch lifecycle helpers (ADR 0012).
//
// These wrap the GmailClient methods so the OAuth callback and disconnect
// mutation can operate on a userId without each call site re-deriving the
// client. They also persist the resulting historyId/expiry into GmailMailbox.
// -----------------------------------------------------------------------------

/** Topic name from env or fallback used in dev. */
function getPubSubTopic(): string {
  return (
    process.env['GMAIL_PUBSUB_TOPIC'] ?? 'projects/studymind/topics/gmail-watch'
  )
}

export interface SetupWatchForUserOptions {
  /** Address discovered during the OAuth handshake. */
  address: string
  /** Override the gmail SDK constructor (tests). */
  factory?: () => gmail_v1.Gmail
}

/**
 * Start (or restart) the Pub/Sub watch for a user's mailbox and persist the
 * resulting historyId/expiry. Idempotent — re-calling refreshes the watch.
 */
export async function setupWatchForUser(
  userId: string,
  opts: SetupWatchForUserOptions,
): Promise<GmailWatchResult> {
  const factory = opts.factory
  const client = await createClientForAgent(
    factory
      ? { agentId: userId, factory }
      : { agentId: userId, purpose: 'gmail.oauth_connect' },
  )
  const topicName = getPubSubTopic()
  const result = await client.setupWatch({ topicName })
  // Multi-mailbox: agent may already have N mailboxes. Key on address (which
  // is globally unique to a Google account). The first mailbox an agent
  // connects becomes their default; subsequent ones land as additional.
  const existingForAgent = await db.gmailMailbox.findFirst({
    where: { agentId: userId, deletedAt: null },
    select: { id: true },
  })
  await db.gmailMailbox.upsert({
    where: { address: opts.address },
    create: {
      id: createId(),
      agentId: userId,
      address: opts.address,
      topicName,
      historyId: result.historyId,
      watchExpiresAt: new Date(result.expirationMs),
      isDefault: !existingForAgent,
    },
    update: {
      topicName,
      historyId: result.historyId,
      watchExpiresAt: new Date(result.expirationMs),
      deletedAt: null,
    },
  })
  return result
}

/**
 * Stop the Pub/Sub watch for a user and tombstone their mailbox row. Best
 * effort: a Google-side failure is logged but does not throw, because the
 * user is on a disconnect path and we still want to clear our state.
 */
export async function stopWatchForUser(
  userId: string,
  opts: { factory?: () => gmail_v1.Gmail } = {},
): Promise<void> {
  try {
    const client = await createClientForAgent(
      opts.factory
        ? { agentId: userId, factory: opts.factory }
        : { agentId: userId, purpose: 'gmail.oauth_disconnect' },
    )
    await client.stopWatch()
  } catch {
    // Token may already be revoked; swallow and proceed.
  }
  await db.gmailMailbox.updateMany({
    where: { agentId: userId, deletedAt: null },
    data: { deletedAt: new Date(), watchExpiresAt: null },
  })
}

/**
 * Flip the connection status to `needs_reconnect`. Called by background jobs
 * when Google returns `invalid_grant` on a refresh attempt.
 */
export async function markNeedsReconnect(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { gmailConnectionStatus: 'needs_reconnect' },
  })
  await db.gmailMailbox.updateMany({
    where: { agentId: userId, deletedAt: null },
    data: { watchExpiresAt: null },
  })
}

/**
 * True if the error from googleapis is an `invalid_grant` token-refresh
 * failure — i.e. the refresh token has been revoked or expired and the user
 * must reconnect. Detection is best-effort across googleapis versions.
 */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  const code = (e['code'] ?? e['status']) as string | number | undefined
  const msg = String(e['message'] ?? '')
  const data = (e['response'] as { data?: { error?: string } } | undefined)?.data
  if (data?.error === 'invalid_grant') return true
  if (typeof msg === 'string' && msg.toLowerCase().includes('invalid_grant')) return true
  if (code === 400 && msg.toLowerCase().includes('invalid_grant')) return true
  return false
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
