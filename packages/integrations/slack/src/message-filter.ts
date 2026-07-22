// Which Slack channel messages we ingest into the customer record (§3, §12).
//
// Only human-authored messages WITH text are ingested. We skip:
//   - non-`message` events,
//   - messages with no text,
//   - housekeeping/edit subtypes (joins, topic changes, edits, deletes, …),
//   - anything carrying a `bot_id` / `app_id` — i.e. posts from a bot or app.
//
// IMPORTANT: we do NOT reject EVERY subtype. Slack tags genuine human content
// with content-bearing subtypes too — `file_share` (a call summary posted with
// a screenshot/recording attached), `thread_broadcast` (a reply also sent to
// the channel), `me_message` — and the team's call summaries frequently carry
// attachments. A blanket subtype reject silently dropped all of those. We skip
// only the explicit non-content subtypes below.
//
// The bot/app guard matters now that the CRM posts EVERY call summary into
// `#callsummaries` (ADR 0039 amendment). Those posts carry the contact's name,
// phone and email in the headline, so without this guard the ingestion would
// re-ingest the CRM's own announcement and create a DUPLICATE `slack_summary`
// Interaction for a record that is already on the timeline as a `call_summary`.
// We never silently duplicate (§3). Human agents post from their own user
// accounts (no bot_id), so genuine call summaries typed in Slack are unaffected.

import type { SlackMessageEvent } from './types'

/** Subtypes that are channel housekeeping or edits — never customer content.
 *  Anything NOT in this set (incl. file_share, thread_broadcast, me_message,
 *  and the common `undefined`) is treated as ingestable human content. */
export const NON_CONTENT_SUBTYPES: ReadonlySet<string> = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'bot_message',
  'message_changed',
  'message_deleted',
  'message_replied',
  'reminder_add',
  'tombstone',
  'ekm_access_denied',
  'pinned_item',
  'unpinned_item',
])

/** True when a subtype means "skip this — not customer content". */
export function isSkippableSubtype(subtype: string | null | undefined): boolean {
  return subtype != null && NON_CONTENT_SUBTYPES.has(subtype)
}

export type IngestableMessage = Pick<
  SlackMessageEvent,
  'type' | 'text' | 'subtype' | 'bot_id' | 'app_id'
>

// Generic type predicate so callers keep their concrete type AND get `text`
// narrowed to a non-optional string (the inline guard this replaced did the
// same narrowing — without it, every later `message.text` use becomes
// `string | undefined`).
export function isIngestableSlackMessage<T extends IngestableMessage>(
  message: T,
): message is T & { text: string } {
  if (message.type !== 'message') return false
  if (!message.text) return false
  if (isSkippableSubtype(message.subtype)) return false
  if (message.bot_id || message.app_id) return false
  return true
}
