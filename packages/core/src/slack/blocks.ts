// Pure Slack Block Kit builder for the call-summary "Internal — Slack" post
// (CLAUDE.md §12, §30). Kept here (no I/O) so it is unit-testable; the web
// sender supplies the resolved values and hands the blocks to the audited
// `postAlert` outbound. We only emit URL buttons (deep links back into the
// CRM) — there is no inbound Slack interactivity endpoint yet.

import type { SlackActionButton } from './types'

/**
 * What state the call summary is in when it lands in `#callsummaries` (ADR 0039
 * amendment). Drives the unambiguous status banner so a busy channel reads at a
 * glance whether the customer has already been contacted or whether someone
 * still needs to act.
 *   - `sent_to_customer` — the sales team has already sent it; no action needed.
 *   - `va_handoff`       — the VA team must send it and clear it on the CRM.
 *   - `logged`           — recorded for the team; no customer message went out.
 */
export type CallSummaryDisposition = 'sent_to_customer' | 'va_handoff' | 'logged'

/** A follow-up task raised alongside the summary, surfaced in the Slack post. */
export interface CallSummaryFollowUp {
  title: string
  dueAt?: Date | string | null
  /** Person or team the task is for. */
  assignee?: string | null
}

export interface CallSummarySlackBlockArgs {
  contactName: string
  body: string
  /** The contact's CRM URL — also substituted into button `{{contactUrl}}`. */
  contactUrl: string
  buttons: ReadonlyArray<SlackActionButton>
  /** E.164 phone + email — rendered in the headline so the VA team can act
   *  without opening the CRM. */
  contactPhone?: string | null
  contactEmail?: string | null
  /** Call outcome — drives the headline verb ("Call completed", …). */
  outcome?: 'answered' | 'voicemail' | 'no_answer' | null
  /** ADR 0039 amendment: the rich, status-led layout. When supplied it takes
   *  precedence over `variant`. */
  disposition?: CallSummaryDisposition
  /** Channels the customer summary was actually sent on (e.g. ['Email',
   *  'WhatsApp']) — listed in the `sent_to_customer` banner. */
  sentChannels?: ReadonlyArray<string>
  /** Follow-up tasks to highlight under the summary. */
  followUps?: ReadonlyArray<CallSummaryFollowUp>
  /** Who a `va_handoff` is assigned to (person or team name). */
  handoffAssignee?: string | null
  /** The staff member who logged the summary — rendered as a footer. */
  authorName?: string | null
  /** Legacy layout hint (pre-disposition). 'internal_note' renders the VA-team
   *  layout, 'summary' the classic single section. Retained for back-compat;
   *  `disposition` supersedes it. */
  variant?: 'summary' | 'internal_note'
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
  const verb = (args.outcome && OUTCOME_LABELS[args.outcome]) || 'Call completed'
  return [verb, args.contactName, args.contactPhone, args.contactEmail]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(' — ')
}

/** Substitute the `{{contactUrl}}` placeholder in a button url. */
export function resolveButtonUrl(template: string, contactUrl: string): string {
  return template.replaceAll('{{contactUrl}}', contactUrl)
}

const DISPOSITION_HEADER: Record<CallSummaryDisposition, string> = {
  sent_to_customer: '✅ Call summary — ALREADY SENT to the customer',
  va_handoff: '🚨 Call summary — ACTION REQUIRED from the VA team',
  logged: '📝 Call summary — logged on the CRM',
}

/** Short, human date for a follow-up due. Best-effort — an unparseable value is
 *  dropped rather than rendered as "Invalid Date". */
function formatDue(value: Date | string | null | undefined): string | null {
  if (value == null) return null
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d)
}

/** The disposition-specific status banner — the line that makes it "awfully
 *  clear" what has (or hasn't) happened with the customer. */
function dispositionBanner(args: CallSummarySlackBlockArgs, d: CallSummaryDisposition): string {
  if (d === 'sent_to_customer') {
    const via =
      args.sentChannels && args.sentChannels.length > 0 ? ` (${args.sentChannels.join(', ')})` : ''
    return `✅ *The sales team has already sent this call summary to the customer${via}.* No need to send it again.`
  }
  if (d === 'va_handoff') {
    const who = args.handoffAssignee ? `\n👤 *Assigned to:* ${args.handoffAssignee}` : ''
    return `🚨 *VA team — please action this.* Send this summary to the customer, then mark it cleared on the CRM.${who}`
  }
  return 'ℹ️ Logged on the CRM for the team — no customer message was sent.'
}

/** The "Follow-up task(s)" bullet list, or null when there are none. */
function followUpsSection(
  followUps: ReadonlyArray<CallSummaryFollowUp> | undefined,
): string | null {
  if (!followUps || followUps.length === 0) return null
  const lines = followUps.map((f) => {
    const due = formatDue(f.dueAt)
    const dueStr = due ? ` (due ${due})` : ''
    const who = f.assignee ? ` — ${f.assignee}` : ''
    return `• ${f.title}${dueStr}${who}`
  })
  return `📋 *Follow-up task${followUps.length > 1 ? 's' : ''}:*\n${lines.join('\n')}`
}

/** The rich, disposition-led block layout (ADR 0039 amendment). */
function dispositionBlocks(args: CallSummarySlackBlockArgs, d: CallSummaryDisposition): unknown[] {
  const blocks: unknown[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `*${DISPOSITION_HEADER[d]}*` } },
    { type: 'section', text: { type: 'mrkdwn', text: buildCallSummaryHeadline(args) } },
    { type: 'divider' },
    { type: 'section', text: { type: 'mrkdwn', text: args.body } },
    { type: 'section', text: { type: 'mrkdwn', text: dispositionBanner(args, d) } },
  ]
  const followUps = followUpsSection(args.followUps)
  if (followUps) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: followUps } })
  }
  if (args.authorName && args.authorName.trim()) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Logged by ${args.authorName.trim()}` }],
    })
  }
  return blocks
}

/**
 * Build the Block Kit payload for a call-summary Slack post. Returns a section
 * with the summary text plus (when buttons are configured) an actions block of
 * URL buttons. Slack caps an actions block at 5 elements; callers already cap
 * the stored array at 5 (see SlackActionButtons), and we slice defensively.
 */
export function buildCallSummarySlackBlocks(args: CallSummarySlackBlockArgs): unknown[] {
  // ADR 0039 amendment: when a disposition is supplied, render the rich,
  // status-led layout. Otherwise fall back to the legacy variant layout so
  // existing callers (and tests) are unaffected.
  const blocks: unknown[] = args.disposition
    ? dispositionBlocks(args, args.disposition)
    : args.variant === 'internal_note'
      ? [
          // VA-team layout: who + how to reach them on the first line, then
          // the pending actions — readable at a glance in a busy channel.
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `*${buildCallSummaryHeadline(args)}*` },
          },
          { type: 'divider' },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Pending tasks for VA team*\n${args.body}`,
            },
          },
        ]
      : [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Call summary — ${args.contactName}*\n\n${args.body}`,
            },
          },
        ]

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
  if (args.disposition) {
    const parts = [
      DISPOSITION_HEADER[args.disposition],
      buildCallSummaryHeadline(args),
      '',
      args.body,
      '',
      dispositionBanner(args, args.disposition).replaceAll('*', ''),
    ]
    const followUps = followUpsSection(args.followUps)
    if (followUps) parts.push('', followUps.replaceAll('*', ''))
    parts.push('', args.contactUrl)
    return parts.join('\n')
  }
  if (args.variant === 'internal_note') {
    return `${buildCallSummaryHeadline(args)}\n\nPending tasks for VA team\n${args.body}\n\n${args.contactUrl}`
  }
  return `Call summary for ${args.contactName}\n\n${args.body}\n\n${args.contactUrl}`
}
