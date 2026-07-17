// Channel-aware ingestion rules (ADR 0042). Pure decisions only — the impure
// executor lives in complaints.ts.
//
// The team's Slack layout encodes intent in the channel NAME: a call summary
// posted in #complaintcallsummaries (or #complaints-…) IS a complaint being
// logged, so once the message links to a Contact the CRM opens a Complaint on
// the existing Complaints queue automatically instead of waiting for a human
// to re-type it. Matching is by name substring so renames/new channels
// (#b2bcomplaints, #complaint-escalations) keep working with no code change.

import { SLACK_EMOJI_CODE_RE, slackTextToPlain } from './extract'

/** Mentions older than this never auto-open a NEW complaint — the 90-day
 *  backfill and deep history pulls must not flood the Active queue with
 *  complaints that were resolved long ago outside the CRM. */
export const COMPLAINT_AUTO_RAISE_HORIZON_MS = 7 * 24 * 60 * 60 * 1000

/** AI slack-summary category → Complaint preset category (complaint.ts router
 *  PRESET_CATEGORIES). Unknown/absent categories stay null — staff pick one. */
const SLACK_CATEGORY_TO_COMPLAINT: Record<string, string> = {
  billing: 'Billing',
  scheduling: 'Scheduling',
  academic: 'Teaching quality',
}

export function isComplaintChannel(channelName: string | null | undefined): boolean {
  if (!channelName) return false
  return channelName.toLowerCase().replace(/^#/u, '').includes('complaint')
}

/** Tolerated clock skew for a mention timestamped slightly in the future —
 *  beyond this the ts is garbage and the horizon must not be bypassed. */
const FUTURE_SKEW_TOLERANCE_MS = 24 * 60 * 60 * 1000

/** Should this linked mention auto-open a Complaint? Contact-linked mentions
 *  only (an org-only mention has nobody to log the complaint against), in a
 *  complaint-flavoured channel, and recent enough to still be live. */
export function shouldAutoRaiseComplaint(input: {
  channelName: string | null | undefined
  contactId: string | null | undefined
  occurredAt: Date
  now: Date
}): boolean {
  if (!isComplaintChannel(input.channelName)) return false
  if (!input.contactId) return false
  const age = input.now.getTime() - input.occurredAt.getTime()
  return age <= COMPLAINT_AUTO_RAISE_HORIZON_MS && age >= -FUTURE_SKEW_TOLERANCE_MS
}

export interface ComplaintDraft {
  title: string
  description: string
  category: string | null
}

/** Title = the message's first meaningful line (the team's call-log format
 *  leads with "Name +44… Medic Mind"); description = the whole plain text.
 *  :emoji: shortcodes (the team's :gb:/:large_purple_circle: markers) are
 *  stripped — they are routing decoration, not complaint content. */
export function buildComplaintDraft(input: {
  messageText: string
  aiCategory: string | null | undefined
}): ComplaintDraft {
  const plain = slackTextToPlain(input.messageText)
    .replace(SLACK_EMOJI_CODE_RE, ' ')
    .replace(/[ \t]{2,}/gu, ' ')
  const firstLine =
    plain
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? ''
  return {
    title: (firstLine || 'Complaint call summary (Slack)').slice(0, 200),
    description: plain.trim().slice(0, 4000),
    category: input.aiCategory ? (SLACK_CATEGORY_TO_COMPLAINT[input.aiCategory] ?? null) : null,
  }
}
