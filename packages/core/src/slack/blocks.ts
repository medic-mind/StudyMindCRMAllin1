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
  const heading = `*Call summary — ${args.contactName}*`
  const blocks: unknown[] = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${heading}\n\n${args.body}` },
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
}): string {
  return `Call summary for ${args.contactName}\n\n${args.body}\n\n${args.contactUrl}`
}
