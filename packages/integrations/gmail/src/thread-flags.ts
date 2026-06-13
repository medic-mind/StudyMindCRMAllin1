// Pure mapping from a Gmail thread's aggregated label set to the CRM's
// conversation-head flags (ADR 0021 Phase 5 — inbound half of two-way sync).
//
// Gmail expresses read / star / archive / trash as system labels on each
// message; we aggregate them across the thread (see GmailClient.getThreadState)
// and collapse to the four booleans the Conversation head needs. Kept pure and
// unit-tested so the convergence rules are pinned independently of the SDK.

export interface GmailThreadFlags {
  /** No message in the thread carries UNREAD. */
  isRead: boolean
  /** At least one message carries STARRED. */
  isStarred: boolean
  /** Not in the inbox and not in trash — i.e. archived. */
  isArchived: boolean
  /** In TRASH (recoverable for 30 days). */
  isTrashed: boolean
}

/**
 * Collapse a thread's union of Gmail label ids into the CRM head flags.
 *
 * Precedence: TRASH wins over INBOX/archive — a trashed thread is reported as
 * trashed, never archived, so the two states stay mutually exclusive in the UI.
 */
export function deriveThreadFlags(labelIds: readonly string[]): GmailThreadFlags {
  const labels = new Set(labelIds)
  const isTrashed = labels.has('TRASH')
  return {
    isRead: !labels.has('UNREAD'),
    isStarred: labels.has('STARRED'),
    isArchived: !isTrashed && !labels.has('INBOX'),
    isTrashed,
  }
}

/** Flags for a thread Gmail no longer has (permanently deleted). We never
 *  hard-delete the CRM record (§3, no silent delete) — we mark it trashed and
 *  read so it falls out of the active inbox but stays recoverable/auditable. */
export const DELETED_THREAD_FLAGS: GmailThreadFlags = {
  isRead: true,
  isStarred: false,
  isArchived: false,
  isTrashed: true,
}
