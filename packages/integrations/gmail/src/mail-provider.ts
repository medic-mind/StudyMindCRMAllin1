// Gmail implementation of the provider-agnostic MailSyncProvider seam (ADR
// 0021 Phase 2). Thin pass-through: each method delegates to the existing
// `GmailClient`, which already owns the OAuth + SDK + push lifecycle.
//
// The shared types in `@studymind/core/mail` are structurally compatible with
// the Gmail-specific shapes here, so the adapter is a 1:1 rename in most
// methods and never copies payloads.

import type {
  MailAttachmentMeta,
  MailChangeBatch,
  MailHeader,
  MailLabelRef,
  MailMessage,
  MailMessageRef,
  MailPushSubscription,
  MailSyncProvider,
} from '@studymind/core/mail'

import {
  createClientForAgent,
  stopWatchForUser,
  type CreateGmailClientOptions,
  type GmailAttachmentMeta,
  type GmailClient,
  type GmailHeader,
  type GmailMessage,
} from './client'

export interface CreateGmailMailSyncProviderOptions {
  /** The MailAccount.id this provider operates on. */
  accountId: string
  /** The owning User.id (carries OAuth context). */
  agentId: string
  /** Overrides for the underlying Gmail SDK client (tests). */
  clientOptions?: Pick<CreateGmailClientOptions, 'factory' | 'refreshToken' | 'purpose' | 'requestId'>
}

const toHeader = (h: GmailHeader): MailHeader => ({ name: h.name, value: h.value })
const toAttachment = (a: GmailAttachmentMeta): MailAttachmentMeta => ({
  attachmentId: a.attachmentId,
  filename: a.filename,
  mimeType: a.mimeType,
  sizeBytes: a.sizeBytes,
})
const toMessage = (m: GmailMessage): MailMessage => ({
  id: m.id,
  threadId: m.threadId,
  internalDate: m.internalDate,
  headers: m.headers.map(toHeader),
  body: m.body,
  attachments: m.attachments.map(toAttachment),
})

/**
 * Build a `MailSyncProvider` over Gmail. Lazily constructs the underlying
 * `GmailClient` on first use so callers can keep the provider instance
 * lightweight (no decryption or network until needed).
 */
export function createGmailMailSyncProvider(
  opts: CreateGmailMailSyncProviderOptions,
): MailSyncProvider {
  let cached: Promise<GmailClient> | null = null
  const client = async (): Promise<GmailClient> => {
    if (!cached) {
      cached = createClientForAgent({
        agentId: opts.agentId,
        ...(opts.clientOptions ?? {}),
      })
    }
    return cached
  }

  return {
    accountId: opts.accountId,
    provider: 'gmail',

    async fetchMessage(messageId): Promise<MailMessage> {
      const c = await client()
      return toMessage(await c.getMessage(messageId))
    },

    async fetchAttachment(messageId, attachmentId): Promise<Buffer> {
      const c = await client()
      return c.getAttachment(messageId, attachmentId)
    },

    async listChangesSince(cursor): Promise<MailChangeBatch> {
      // Gmail uses an opaque numeric historyId; the seam treats it as a string.
      // An empty cursor on Gmail's API would mean "from the beginning" — that's
      // not what we want for a sync. We require a baseline from the caller; an
      // empty cursor falls back to the latest history id by calling setupPush
      // (which returns the current history id). The dispatcher / caller is
      // responsible for baselining before the first listChangesSince call.
      if (!cursor) {
        throw new Error(
          'listChangesSince requires a baseline cursor on Gmail — call setupPush first to get one.',
        )
      }
      const c = await client()
      const result = await c.listHistorySince(cursor)
      return {
        added: result.added.map((a) => ({
          messageId: a.messageId,
          threadId: a.threadId,
        })),
        nextCursor: result.newHistoryId,
      }
    },

    async sendRaw(input): Promise<MailMessageRef> {
      const c = await client()
      const ref = await c.sendMessage({ raw: input.raw })
      return { id: ref.id, threadId: ref.threadId }
    },

    async setupPush(input): Promise<MailPushSubscription> {
      const c = await client()
      const r = await c.setupWatch({ topicName: input.topicOrUrl })
      return { cursor: r.historyId, expiresAtMs: r.expirationMs }
    },

    async stopPush(): Promise<void> {
      // Use the standalone helper that already silences errors.
      await stopWatchForUser(opts.agentId)
    },

    // --- ADR 0021 Phase 5 — two-way action sync (Gmail system labels) ---
    async setReadState(threadId, read): Promise<void> {
      const c = await client()
      await c.modifyThread({
        threadId,
        ...(read ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] }),
      })
    },
    async setArchived(threadId, archived): Promise<void> {
      const c = await client()
      await c.modifyThread({
        threadId,
        ...(archived ? { removeLabelIds: ['INBOX'] } : { addLabelIds: ['INBOX'] }),
      })
    },
    async setStarred(threadId, starred): Promise<void> {
      const c = await client()
      await c.modifyThread({
        threadId,
        ...(starred ? { addLabelIds: ['STARRED'] } : { removeLabelIds: ['STARRED'] }),
      })
    },
    async setTrashed(threadId, trashed): Promise<void> {
      const c = await client()
      if (trashed) await c.trashThread(threadId)
      else await c.untrashThread(threadId)
    },
    async modifyLabels(threadId, change): Promise<void> {
      const c = await client()
      await c.modifyThread({
        threadId,
        ...(change.add ? { addLabelIds: change.add } : {}),
        ...(change.remove ? { removeLabelIds: change.remove } : {}),
      })
    },
    async listLabels(): Promise<MailLabelRef[]> {
      const c = await client()
      return c.listLabels()
    },
  }
}
