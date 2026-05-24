// KPI strip at the top of the customer view. One tile per channel; each
// tile links to its section below via an in-page anchor. RSC.

import Link from 'next/link'

import type { ChannelSummary } from '@/lib/view-models/contact-channels'

interface Props {
  summary: ChannelSummary
}

function Tile({
  href,
  label,
  primary,
  secondary,
}: {
  href: string
  label: string
  primary: string
  secondary?: string
}) {
  return (
    <Link
      href={href}
      className="flex flex-1 flex-col gap-0.5 rounded-md border border-neutral-200 bg-white px-3 py-2 text-left hover:border-neutral-400"
    >
      <span className="text-[11px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      <span className="text-lg font-semibold tabular-nums text-neutral-900">
        {primary}
      </span>
      {secondary && (
        <span className="text-xs text-neutral-600">{secondary}</span>
      )}
    </Link>
  )
}

export function ChannelTiles({ summary }: Props): JSX.Element {
  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Tile
        href="#section-email"
        label="Email"
        primary={`${summary.emails.threadCount} thread${summary.emails.threadCount === 1 ? '' : 's'}`}
        secondary={
          summary.emails.unreadCount > 0
            ? `${summary.emails.unreadCount} unread`
            : 'all read'
        }
      />
      <Tile
        href="#section-calls"
        label="Calls"
        primary={`${summary.calls.recentCount} recent`}
        secondary={
          summary.calls.missedCount > 0
            ? `${summary.calls.missedCount} missed`
            : 'no missed'
        }
      />
      <Tile
        href="#section-slack"
        label="Slack"
        primary={`${summary.slack.mentionCount} mention${summary.slack.mentionCount === 1 ? '' : 's'}`}
      />
      <Tile
        href="#section-trengo"
        label="Trengo"
        primary={`${summary.trengo.conversationCount} convo${summary.trengo.conversationCount === 1 ? '' : 's'}`}
      />
      <Tile
        href="#section-tasks"
        label="Tasks"
        primary={`${summary.tasks.openCount} open`}
      />
    </div>
  )
}
