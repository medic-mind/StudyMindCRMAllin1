// Pure Slack Block Kit builder for the call-summary "Internal — Slack" post
// (CLAUDE.md §12, §30). Kept here (no I/O) so it is unit-testable; the web
// sender supplies the resolved values and hands the blocks to the audited
// `postAlert` outbound. We only emit URL buttons (deep links back into the
// CRM) — there is no inbound Slack interactivity endpoint yet.

import type { SlackActionButton } from './types'

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
  /** 'internal_note' renders the VA-team layout: outcome — name — phone —
   *  email headline plus a "Pending tasks for VA team" section. */
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

/**
 * Build the Block Kit payload for a call-summary Slack post. Returns a section
 * with the summary text plus (when buttons are configured) an actions block of
 * URL buttons. Slack caps an actions block at 5 elements; callers already cap
 * the stored array at 5 (see SlackActionButtons), and we slice defensively.
 */
export function buildCallSummarySlackBlocks(args: CallSummarySlackBlockArgs): unknown[] {
  const blocks: unknown[] =
    args.variant === 'internal_note'
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
export function buildCallSummarySlackText(args: {
  contactName: string
  body: string
  contactUrl: string
  contactPhone?: string | null
  contactEmail?: string | null
  outcome?: 'answered' | 'voicemail' | 'no_answer' | null
  variant?: 'summary' | 'internal_note'
}): string {
  if (args.variant === 'internal_note') {
    return `${buildCallSummaryHeadline(args)}\n\nPending tasks for VA team\n${args.body}\n\n${args.contactUrl}`
  }
  return `Call summary for ${args.contactName}\n\n${args.body}\n\n${args.contactUrl}`
}
