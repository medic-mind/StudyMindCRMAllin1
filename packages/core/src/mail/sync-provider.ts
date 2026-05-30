// Provider-agnostic mail-sync seam (ADR 0021 Phase 2).
//
// Pure types. Each provider (gmail, outlook, exchange, imap, …) implements
// `MailSyncProvider` so the rest of the CRM talks to one stable surface — and
// new providers slot in without touching the domain. CLAUDE.md §5 keeps this
// in `packages/core`: it has no I/O and no dependency on a provider SDK.
//
// `apps/web/lib/mail/get-sync-provider.ts` is the runtime dispatcher; Gmail
// implements it in `packages/integrations/gmail/src/mail-provider.ts`.

// -----------------------------------------------------------------------------
// Normalised message shapes — kept structurally compatible with the existing
// Gmail types (`GmailMessage`, `GmailHeader`, …) so the Gmail adapter is a
// thin pass-through and existing callers can migrate one at a time.
// -----------------------------------------------------------------------------

export interface MailMessageRef {
  /** Provider-side message id (Gmail message id, Graph item id, IMAP UID, …). */
  id: string
  /** Provider-side conversation/thread id. Same id for single-message threads. */
  threadId: string
}

export interface MailHeader {
  name: string
  value: string
}

export interface MailAttachmentMeta {
  /** Provider-side handle used to fetch the attachment bytes. */
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface MailMessage {
  id: string
  threadId: string
  /** Epoch ms of when the message was received/sent (provider time). */
  internalDate: number
  headers: MailHeader[]
  /** Best-effort plain-text body. */
  body: string
  attachments: MailAttachmentMeta[]
}

export interface MailChangeRef {
  messageId: string
  threadId: string
}

export interface MailChangeBatch {
  /** Messages added since the previous cursor. */
  added: MailChangeRef[]
  /** Opaque cursor — pass to the next call to get the following batch. */
  nextCursor: string
}

export interface MailPushSubscription {
  /** Opaque cursor returned by the provider when the subscription is set up. */
  cursor: string
  /** Wall-clock expiry of the push subscription (UTC ms). */
  expiresAtMs: number
}

// -----------------------------------------------------------------------------
// The seam itself.
// -----------------------------------------------------------------------------

/**
 * One mailbox / account, abstracted across providers. A `MailSyncProvider` is
 * stateless and re-issuable per call; the implementation holds whatever auth
 * context it needs (Gmail OAuth refresh token, Graph access token, IMAP creds).
 */
export interface MailSyncProvider {
  /** The MailAccount this provider was constructed for. */
  readonly accountId: string
  /** Provider id (gmail|google_workspace|outlook|exchange|imap). */
  readonly provider: string
  /** Fetch a single message by provider id. */
  fetchMessage(messageId: string): Promise<MailMessage>
  /** Fetch attachment bytes for a message. */
  fetchAttachment(messageId: string, attachmentId: string): Promise<Buffer>
  /**
   * Pull changes since the supplied cursor. Returns added messages and the
   * next cursor. The first call with an empty / null cursor is a full sync of
   * the recent window per provider semantics.
   */
  listChangesSince(cursor: string | null): Promise<MailChangeBatch>
  /**
   * Send a raw RFC 5322 message. The implementation handles per-provider
   * encoding (Gmail expects base64url-encoded `raw`; Graph expects MIME).
   */
  sendRaw(input: { raw: string }): Promise<MailMessageRef>
  /**
   * Set up real-time push (Gmail watch / Graph change notifications). Returns
   * a cursor for `listChangesSince` to baseline against, plus the expiry.
   * `topicOrUrl` is the provider-specific endpoint (Pub/Sub topic for Gmail,
   * webhook URL for Graph). Providers without push throw `MailFeatureUnsupported`.
   */
  setupPush(input: { topicOrUrl: string }): Promise<MailPushSubscription>
  /** Tear down the push subscription. Best effort — never throws. */
  stopPush(): Promise<void>
}

// -----------------------------------------------------------------------------
// Errors. Imported by both the seam consumers and the adapters.
// -----------------------------------------------------------------------------

/** Thrown by a dispatcher when a non-connectable provider is asked for. */
export class MailProviderUnavailableError extends Error {
  readonly code = 'MAIL_PROVIDER_UNAVAILABLE'
  constructor(public readonly provider: string) {
    super(`Mail provider '${provider}' is not connectable yet (ADR 0021).`)
    this.name = 'MailProviderUnavailableError'
  }
}

/** Thrown when an adapter is asked to do something its provider does not
 * support (e.g. push for IMAP). */
export class MailFeatureUnsupportedError extends Error {
  readonly code = 'MAIL_FEATURE_UNSUPPORTED'
  constructor(
    public readonly provider: string,
    public readonly feature: string,
  ) {
    super(`Provider '${provider}' does not support '${feature}'.`)
    this.name = 'MailFeatureUnsupportedError'
  }
}
