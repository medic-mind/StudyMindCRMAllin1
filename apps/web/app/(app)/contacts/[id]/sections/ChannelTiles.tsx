// KPI strip at the top of the customer view. One tile per channel; each tile
// links to its section below via an in-page anchor. Branded to match the
// dashboard KpiTile (left accent bar, icon chip, mono value). CLAUDE.md §4.

import Link from 'next/link'
import type { ReactNode } from 'react'

import {
  ListTodoIcon,
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  SmartphoneIcon,
} from '@/components/ui/icon'
import type { ChannelSummary } from '@/lib/view-models/contact-channels'

type Tone = 'neutral' | 'info' | 'success' | 'warn' | 'accent'

const BAR: Record<Tone, string> = {
  neutral: 'bg-neutral-300',
  info: 'bg-primary-500',
  success: 'bg-emerald-500',
  warn: 'bg-amber-500',
  accent: 'bg-violet-500',
}

const CHIP: Record<Tone, string> = {
  neutral: 'bg-neutral-100 text-neutral-500',
  info: 'bg-primary-50 text-primary-700',
  success: 'bg-emerald-50 text-emerald-700',
  warn: 'bg-amber-50 text-amber-700',
  accent: 'bg-violet-50 text-violet-700',
}

function Tile({
  href,
  label,
  primary,
  secondary,
  tone,
  icon,
}: {
  href: string
  label: string
  primary: string
  secondary?: string
  tone: Tone
  icon: ReactNode
}) {
  return (
    <Link
      href={href}
      className="group relative flex min-w-[8.5rem] flex-1 flex-col gap-1 overflow-hidden rounded-xl border border-neutral-200 bg-white px-3 py-2.5 pl-4 shadow-card transition-shadow hover:shadow-card-hover"
    >
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-1 ${BAR[tone]}`} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium uppercase tracking-wide text-neutral-500">
          {label}
        </span>
        <span
          aria-hidden="true"
          className={`flex h-6 w-6 items-center justify-center rounded-md ${CHIP[tone]}`}
        >
          {icon}
        </span>
      </div>
      <span className="font-mono text-xl font-semibold tabular-nums text-neutral-900">
        {primary}
      </span>
      <span className="text-xs text-neutral-500">{secondary ?? ' '}</span>
    </Link>
  )
}

export function ChannelTiles({ summary }: { summary: ChannelSummary }): JSX.Element {
  return (
    <div className="mt-5 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-5">
      <Tile
        href="#section-email"
        label="Email"
        tone={summary.emails.unreadCount > 0 ? 'info' : 'neutral'}
        icon={<MailIcon size={14} />}
        primary={`${summary.emails.threadCount}`}
        secondary={
          summary.emails.unreadCount > 0
            ? `${summary.emails.unreadCount} unread`
            : 'all read'
        }
      />
      <Tile
        href="#section-calls"
        label="Calls"
        tone={summary.calls.missedCount > 0 ? 'warn' : 'neutral'}
        icon={<PhoneIcon size={14} />}
        primary={`${summary.calls.recentCount}`}
        secondary={
          summary.calls.missedCount > 0
            ? `${summary.calls.missedCount} missed`
            : 'no missed'
        }
      />
      <Tile
        href="#section-slack"
        label="Slack"
        tone="neutral"
        icon={<MessageSquareIcon size={14} />}
        primary={`${summary.slack.mentionCount}`}
        secondary={`mention${summary.slack.mentionCount === 1 ? '' : 's'}`}
      />
      <Tile
        href="#section-trengo"
        label="Trengo"
        tone="neutral"
        icon={<SmartphoneIcon size={14} />}
        primary={`${summary.trengo.conversationCount}`}
        secondary={`conversation${summary.trengo.conversationCount === 1 ? '' : 's'}`}
      />
      <Tile
        href="#section-tasks"
        label="Tasks"
        tone={summary.tasks.openCount > 0 ? 'warn' : 'success'}
        icon={<ListTodoIcon size={14} />}
        primary={`${summary.tasks.openCount}`}
        secondary={summary.tasks.openCount > 0 ? 'open' : 'all done'}
      />
    </div>
  )
}
