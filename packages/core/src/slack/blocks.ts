// Pure Slack Block Kit builder for the call-summary `#callsummaries` post
// (CLAUDE.md §12, §30). Kept here (no I/O) so it is unit-testable; the web
// sender supplies the resolved values and hands the blocks to the audited
// `postAlert` outbound. We only emit URL buttons (deep links back into the
// CRM) — there is no inbound Slack interactivity endpoint yet.
//
// The call-summary flow is deliberately simple (redesign 2026-07): a staff
// member types the summary, it is recorded on the customer's CRM record, and
// it is announced here. No customer message is ever sent from the CRM, so
// there is exactly ONE layout — who the call was with, the outcome, the
// summary text, and who logged it.

import type { SlackActionButton } from './types'

export interface CallSummarySlackBlockArgs {
  contactName: string
  body: string
  /** The contact's CRM URL — also substituted into button `{{contactUrl}}`. */
  contactUrl: string
  buttons: ReadonlyArray<SlackActionButton>
  /** E.164 phone + email — rendered in the headline so the team can act
   *  without opening the CRM. */
  contactPhone?: string | null
  contactEmail?: string | null
  /** Call outcome — drives the headline verb ("Call completed", …). */
  outcome?: 'answered' | 'voicemail' | 'no_answer' | null
  /** The staff member who logged the summary — rendered as a footer. */
  authorName?: string | null
}

const OUTCOME_LABELS: Record<string, string> = {
  answered: 'Call completed',
  voicemail: 'Voicemail left',
  no_answer: 'No answer',
}

/** "Call completed — Jane Smith — +447700900123 — jane@x.com" (parts that
 *  exist only). Exported for the text fallback + tests. */
export function buildCallSummaryHeadline(args: {
  contactName: string
  contactPhone?: string | null
  contactEmail?: string | null
  outcome?: 'answered' | 'voicemail' | 'no_answer' | null
}): string {
  const verb = (args.outcome && OUTCOME_LABELS[args.outcome]) || 'Call summary'
  return [verb, args.contactName, args.contactPhone, args.contactEmail]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' — ')
}

/** Substitute the `{{contactUrl}}` placeholder in a button url. */
export function resolveButtonUrl(template: string, contactUrl: string): string {
  return template.replaceAll('{{contactUrl}}', contactUrl)
}

/**
 * Build the Block Kit payload for a call-summary Slack post: a headline
 * (outcome — name — phone — email), the summary body, an optional "logged by"
 * footer, and (when configured) an actions block of URL buttons. Slack caps an
 * actions block at 5 elements; callers already cap the stored array at 5 (see
 * SlackActionButtons), and we slice defensively.
 */
export function buildCallSummarySlackBlocks(args: CallSummarySlackBlockArgs): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*📞 ${buildCallSummaryHeadline(args)}*` } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: args.body } },
  ]

  if (args.authorName && args.authorName.trim()) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Logged by ${args.authorName.trim()}` }],
    })
  }

  const buttons = args.buttons.slice(0, 5).map((b) => ({
    type: 'button',
    text: { type: 'plain_text', text: b.label, emoji: true },
    url: resolveButtonUrl(b.url, args.contactUrl),
  }))
  if (buttons.length > 0) {
    blocks.push({ type: 'actions', elements: buttons })
  }

  return blocks
}

/** Plain-text fallback used as the message `text` alongside the blocks. */
export function buildCallSummarySlackText(args: CallSummarySlackBlockArgs): string {
  return `${buildCallSummaryHeadline(args)}\n\n${args.body}\n\n${args.contactUrl}`
}

// -----------------------------------------------------------------------------
// Complaint fan-out (CRM → #complaintcallsummaries). The reverse of the
// Slack→CRM complaint import: a complaint LOGGED IN THE CRM is announced to the
// operator-routed complaint channel in the same structured shape.
// -----------------------------------------------------------------------------

export interface ComplaintSlackArgs {
  contactName: string
  contactEmail?: string | null
  contactPhone?: string | null
  title: string
  /** Full complaint body (narrative + suggested solution + actions). */
  description?: string | null
  category?: string | null
  severity?: string | null
  contactUrl: string
  authorName?: string | null
}

/** "Vyshale Arulalagan — vyvarul@gmail.com — +1647…" (present parts only). */
function complaintClientLine(args: ComplaintSlackArgs): string {
  return [args.contactName, args.contactPhone, args.contactEmail]
    .filter((p): p is string => Boolean(p && p.trim()))
    .join(' — ')
}

function complaintMeta(args: ComplaintSlackArgs): string | null {
  const parts = [
    args.category ? `Category: ${args.category}` : null,
    args.severity ? `Severity: ${args.severity}` : null,
  ].filter((p): p is string => Boolean(p))
  return parts.length > 0 ? parts.join(' · ') : null
}

/** Block Kit payload for a complaint logged in the CRM. */
export function buildComplaintSlackBlocks(args: ComplaintSlackArgs): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*🚩 Complaint logged — ${complaintClientLine(args)}*` } },
  ]
  const meta = complaintMeta(args)
  if (meta) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: meta }] })
  blocks.push({ type: 'divider' })
  const body = (args.description && args.description.trim()) || args.title
  blocks.push({ type: 'section', text: { type: 'mrkdwn', text: body.slice(0, 2900) } })
  if (args.authorName && args.authorName.trim()) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Logged by ${args.authorName.trim()} · <${args.contactUrl}|Open in CRM>` }],
    })
  } else {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `<${args.contactUrl}|Open in CRM>` }] })
  }
  return blocks
}

/** Plain-text fallback used as the message `text` alongside the blocks. */
export function buildComplaintSlackText(args: ComplaintSlackArgs): string {
  const meta = complaintMeta(args)
  const body = (args.description && args.description.trim()) || args.title
  return [
    `🚩 Complaint logged — ${complaintClientLine(args)}`,
    meta,
    '',
    body,
    '',
    args.contactUrl,
  ]
    .filter((l) => l !== null)
    .join('\n')
}
