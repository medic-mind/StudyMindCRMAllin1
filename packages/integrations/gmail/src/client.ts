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
  /** Gmail label ids on the message (system + custom). Custom labels (mapped to
   *  names via listLabels) are surfaced on the Conversation head. */
  labelIds: string[]
  /** Best-effort plain text body (gmail.utils unwraps base64url multiparts). */
  body: string
  /** Best-effort text/html body, when the message carries one. Rendered in the
   *  reading pane's sandboxed iframe so mail looks identical to Gmail. */
  htmlBody: string | null
  attachments: GmailAttachmentMeta[]
}

export interface GmailHistoryAddedMessage {
  messageId: string
  threadId: string
}

export interface GmailHistoryResult {
  /** New messages on the mailbox (messagesAdded). */
  added: GmailHistoryAddedMessage[]
  /**
   * Thread ids whose labels changed or whose messages were removed
   * (labelsAdded / labelsRemoved / messagesDeleted) WITHOUT a new message.
   * These drive `mirrorThreadFlags` — the inbound side of two-way sync (ADR
   * 0021 Phase 5). Threads that also appear in `added` are excluded; the
   * message-processing path already converges their flags.
   */
  changedThreadIds: string[]
  /** Use as the next startHistoryId. */
  newHistoryId: string
}

/** Aggregated current Gmail label state for a thread (ADR 0021 Phase 5). */
export interface GmailThreadState {
  threadId: string
  /** Union of every message's labelIds — e.g. INBOX, UNREAD, STARRED, TRASH. */
  labelIds: string[]
}

export interface GmailWatchResult {
  historyId: string
  expirationMs: number
}

export interface GmailLabelRef {
  id: string
  name: string
}

/** A Gmail "send-as" identity and its signature (users.settings.sendAs). */
export interface GmailSendAs {
  email: string
  displayName: string | null
  /** Signature HTML as Gmail stores it (may be empty string). */
  signatureHtml: string | null
  isPrimary: boolean
  isDefault: boolean
}

export interface GmailClient {
  readonly agentId: string
  getMessage(messageId: string): Promise<GmailMessage>
  listHistorySince(startHistoryId: string): Promise<GmailHistoryResult>
  /**
   * Current aggregated label state for a thread, or null if Gmail no longer
   * has it (permanently deleted). Used by the inbound flag mirror.
   */
  getThreadState(threadId: string): Promise<GmailThreadState | null>
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
  /**
   * The account's send-as identities and signatures. Readable with the
   * gmail.readonly / gmail.modify scopes we already request — no extra consent.
   */
  listSendAs(): Promise<GmailSendAs[]>
}

export interface CreateGmailClientOptions {
  agentId: string
  /** Specific connected mailbox to act as. When set, its OWN refresh token is
   *  used (per-mailbox multi-account); falls back to the agent's default token
   *  if that mailbox has none yet. */
  address?: string
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
  // Per-mailbox token first (multi-account): each connected mailbox syncs with
  // its OWN token instead of sharing the single User pointer.
  if (!refreshToken && opts.address) {
    const mailbox = await db.gmailMailbox.findUnique({
      where: { address: opts.address },
      select: { refreshTokenCipherId: true },
    })
    if (mailbox?.refreshTokenCipherId) {
      refreshToken = await decryptFieldById(db, {
        encryptedFieldId: mailbox.refreshTokenCipherId,
        actorId: opts.agentId,
        purpose: opts.purpose ?? 'gmail.sync',
        ...(opts.requestId ? { requestId: opts.requestId } : {}),
      })
    }
  }
  if (!refreshToken) {
    // ADR 0012: prefer the EncryptedField pointer on User (default mailbox).
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

  // A refresh token only works with the SAME OAuth client that minted it.
  // The connect/callback route (apps/web/.../oauth/gmail) uses
  // GOOGLE_OAUTH_CLIENT_ID/SECRET, so prefer those here and fall back to the
  // legacy GOOGLE_CLIENT_ID/SECRET names for older deployments. Reading a
  // different client id than the one used at connect time silently breaks the
  // refresh (`invalid_client`) — this keeps the two paths in lockstep.
  const oauth2 = new google.auth.OAuth2(
    process.env['GOOGLE_OAUTH_CLIENT_ID'] ?? process.env['GOOGLE_CLIENT_ID'],
    process.env['GOOGLE_OAUTH_CLIENT_SECRET'] ?? process.env['GOOGLE_CLIENT_SECRET'],
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
      // Pull every history type, not just messageAdded: labelsAdded /
      // labelsRemoved / messagesDeleted are how Gmail tells us a thread was
      // read / starred / archived / trashed in the Gmail UI — the inbound half
      // of two-way sync (ADR 0021 Phase 5).
      const added: GmailHistoryAddedMessage[] = []
      const addedThreadIds = new Set<string>()
      const changed = new Set<string>()
      let newHistoryId = startHistoryId
      let pageToken: string | undefined
      do {
        const res = await gmail.users.history.list({
          userId: 'me',
          startHistoryId,
          historyTypes: [
            'messageAdded',
            'labelAdded',
            'labelRemoved',
            'messageDeleted',
          ],
          ...(pageToken ? { pageToken } : {}),
        })
        for (const h of res.data.history ?? []) {
          for (const m of h.messagesAdded ?? []) {
            if (m.message?.id && m.message.threadId) {
              added.push({ messageId: m.message.id, threadId: m.message.threadId })
              addedThreadIds.add(m.message.threadId)
            }
          }
          for (const l of [...(h.labelsAdded ?? []), ...(h.labelsRemoved ?? [])]) {
            if (l.message?.threadId) changed.add(l.message.threadId)
          }
          for (const m of h.messagesDeleted ?? []) {
            if (m.message?.threadId) changed.add(m.message.threadId)
          }
        }
        newHistoryId = res.data.historyId ?? newHistoryId
        pageToken = res.data.nextPageToken ?? undefined
      } while (pageToken)
      // A thread with a brand-new message converges its flags via the message
      // path, so don't double-process it here.
      const changedThreadIds = [...changed].filter((t) => !addedThreadIds.has(t))
      return { added, changedThreadIds, newHistoryId }
    },
    async getThreadState(threadId) {
      try {
        const res = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'minimal',
        })
        const labelIds = new Set<string>()
        for (const m of res.data.messages ?? []) {
          for (const l of m.labelIds ?? []) labelIds.add(l)
        }
        return { threadId, labelIds: [...labelIds] }
      } catch (err) {
        if (isNotFoundError(err)) return null
        throw err
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
    async listSendAs() {
      const res = await gmail.users.settings.sendAs.list({ userId: 'me' })
      return (res.data.sendAs ?? []).map((s) => ({
        email: (s.sendAsEmail ?? '').toLowerCase(),
        displayName: s.displayName || null,
        signatureHtml: s.signature ?? null,
        isPrimary: !!s.isPrimary,
        isDefault: !!s.isDefault,
      }))
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
  let htmlBody = ''

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
    if (part.mimeType === 'text/html' && part.body?.data && !htmlBody) {
      htmlBody = Buffer.from(part.body.data, 'base64url').toString('utf8')
    }
    for (const child of part.parts ?? []) visit(child)
  }

  visit(raw.payload ?? undefined)
  if (!body && raw.payload?.body?.data && raw.payload.mimeType !== 'text/html') {
    body = Buffer.from(raw.payload.body.data, 'base64url').toString('utf8')
  }
  if (!htmlBody && raw.payload?.mimeType === 'text/html' && raw.payload.body?.data) {
    htmlBody = Buffer.from(raw.payload.body.data, 'base64url').toString('utf8')
  }

  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    internalDate: Number(raw.internalDate ?? 0),
    headers,
    labelIds: raw.labelIds ?? [],
    body,
    htmlBody: htmlBody || null,
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
  /** Per-mailbox refresh token (EncryptedField.id) to persist + watch with, so
   *  this mailbox syncs with its OWN token (multi-account). */
  refreshTokenCipherId?: string
  /** Override the gmail SDK constructor (tests). */
  factory?: () => gmail_v1.Gmail
}

/**
 * Start (or restart) the Pub/Sub watch for a user's mailbox and persist the
 * resulting historyId/expiry. Idempotent — re-calling refreshes the watch.
 *
 * The per-mailbox token is stored on the row FIRST so the watch (and every
 * later sync) acts as THIS mailbox via `createClientForAgent({ address })`,
 * rather than the single shared User token.
 */
export async function setupWatchForUser(
  userId: string,
  opts: SetupWatchForUserOptions,
): Promise<GmailWatchResult> {
  const topicName = getPubSubTopic()
  // Multi-mailbox: agent may already have N mailboxes. Key on address (which
  // is globally unique to a Google account). The first mailbox an agent
  // connects becomes their default; subsequent ones land as additional.
  const existingForAgent = await db.gmailMailbox.findFirst({
    where: { agentId: userId, deletedAt: null },
    select: { id: true },
  })
  // Persist the row (with this mailbox's own token) before watching, so the
  // watch client below resolves the per-mailbox token by address.
  await db.gmailMailbox.upsert({
    where: { address: opts.address },
    create: {
      id: createId(),
      agentId: userId,
      address: opts.address,
      topicName,
      isDefault: !existingForAgent,
      ...(opts.refreshTokenCipherId
        ? { refreshTokenCipherId: opts.refreshTokenCipherId }
        : {}),
    },
    update: {
      topicName,
      deletedAt: null,
      ...(opts.refreshTokenCipherId
        ? { refreshTokenCipherId: opts.refreshTokenCipherId }
        : {}),
    },
  })

  const client = await createClientForAgent(
    opts.factory
      ? { agentId: userId, factory: opts.factory }
      : { agentId: userId, address: opts.address, purpose: 'gmail.oauth_connect' },
  )
  const result = await client.setupWatch({ topicName })
  await db.gmailMailbox.update({
    where: { address: opts.address },
    data: {
      historyId: result.historyId,
      watchExpiresAt: new Date(result.expirationMs),
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

/**
 * True if the googleapis error is a 404 — the resource (thread/message) no
 * longer exists on Gmail (permanently deleted). Detection is best-effort
 * across googleapis versions, mirroring `isInvalidGrantError`.
 */
export function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as Record<string, unknown>
  const code = (e['code'] ?? e['status']) as string | number | undefined
  if (code === 404 || code === '404') return true
  const response = e['response'] as { status?: number } | undefined
  if (response?.status === 404) return true
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

/**
 * Display name from a single From-style header, e.g. `Mohil Shah <m@x.com>` →
 * "Mohil Shah", `"Doe, John" <j@x>` → "Doe, John". Returns null for a bare
 * address (no display name) so the caller can fall back to the address. This is
 * the name Gmail shows in the list — without it the UI wrongly falls back to a
 * matched CRM contact's name for every message.
 */
export function parseFromName(value: string | null): string | null {
  if (!value) return null
  const first = value.trim()
  const m = first.match(/^(?:"([^"]*)"|([^<]*))<[^>]+>\s*$/)
  if (m) {
    const name = (m[1] ?? m[2] ?? '').trim().replace(/^['"]|['"]$/g, '').trim()
    return name.length > 0 ? name : null
  }
  return null
}

/** Gmail system label ids that are not user-facing "labels". */
const GMAIL_SYSTEM_LABELS = new Set([
  'INBOX',
  'SENT',
  'DRAFT',
  'TRASH',
  'SPAM',
  'UNREAD',
  'STARRED',
  'IMPORTANT',
  'CHAT',
])

/**
 * Map a message's label ids to its CUSTOM Gmail label NAMES (drops system
 * labels + Gmail's `CATEGORY_*` tabs), using an id→name map from listLabels.
 */
export function customLabelNames(
  labelIds: readonly string[],
  idToName: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = []
  for (const id of labelIds) {
    if (GMAIL_SYSTEM_LABELS.has(id) || id.startsWith('CATEGORY_')) continue
    const name = idToName.get(id)
    if (name) out.push(name)
  }
  return out
}
