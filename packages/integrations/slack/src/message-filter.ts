// Which Slack channel messages we ingest into the customer record (§3, §12).
//
// Only human-authored, top-level messages with text are ingested. We skip:
//   - non-`message` events,
//   - messages with no text,
//   - any subtype (joins, edits, `bot_message`, channel housekeeping),
//   - anything carrying a `bot_id` / `app_id` — i.e. posts from a bot or app.
//
// The bot/app guard matters now that the CRM posts EVERY call summary into
// `#callsummaries` (ADR 0039 amendment). Those posts carry the contact's name,
// phone and email in the headline, so without this guard the ingestion would
// re-ingest the CRM's own announcement and create a DUPLICATE `slack_summary`
// Interaction for a record that is already on the timeline as a `call_summary`.
// We never silently duplicate (§3). Human agents post from their own user
// accounts (no bot_id), so genuine call summaries typed in Slack are unaffected.

import type { SlackMessageEvent } from './types'

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
  if (message.subtype) return false
  if (message.bot_id || message.app_id) return false
  return true
}
