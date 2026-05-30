// Inbox. CLAUDE.md §11 (inbound messages), §20 (role-gated), §26 (RSC by
// default, dense lists, plain-English empty states).
//
// Lists recent inbound message Interactions across all conversations. Each
// row links to the related Contact detail. Pagination is cursor-based; this
// page renders only the first slice — paging comes with the client list.

import Link from 'next/link'
import { TRPCError } from '@trpc/server'

import { PageBody } from '@/components/shell/page-body'
import { PageHeader } from '@/components/shell/page-header'
import { Badge } from '@/components/ui/badge'
import {
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  SmartphoneIcon,
} from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { createServerCaller } from '@/lib/trpc/server'

import { InboxRowActions } from './InboxRowActions'

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

function ChannelIcon({ channel }: { channel: string | null | undefined }) {
  switch (channel) {
    case 'email':
      return <MailIcon size={14} className="text-primary-700" />
    case 'sms':
      return <SmartphoneIcon size={14} className="text-emerald-700" />
    case 'whatsapp':
      return <MessageSquareIcon size={14} className="text-emerald-700" />
    case 'web_chat':
      return <MessageSquareIcon size={14} className="text-primary-700" />
    default:
      return <PhoneIcon size={14} className="text-neutral-500" />
  }
}

type FilterValue = 'all' | 'mine' | 'unassigned' | 'snoozed'

const FILTERS: ReadonlyArray<{ value: FilterValue; label: string }> = [
  { value: 'all', label: 'Active' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'snoozed', label: 'Snoozed' },
]

function parseFilter(raw: string | string[] | undefined): FilterValue {
  const v = Array.isArray(raw) ? raw[0] : raw
  return FILTERS.some((f) => f.value === v) ? (v as FilterValue) : 'all'
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string | string[] }>
}) {
  const params = await searchParams
  const filter = parseFilter(params.filter)
  const caller = await createServerCaller()
  let items: Awaited<ReturnType<typeof caller.inbox.list>>['items'] = []
  let forbidden = false
  try {
    const res = await caller.inbox.list({ limit: 50, filter })
    items = res.items
  } catch (err) {
    if (err instanceof TRPCError && err.code === 'FORBIDDEN') {
      forbidden = true
    } else {
      throw err
    }
  }

  if (forbidden) {
    return (
      <>
        <PageHeader title="Inbox" subtitle="Unassigned conversations" />
        <PageBody>
          <p className="text-sm text-neutral-600">
            You need an agent, ops, DSL, or admin role to view the inbox.
          </p>
        </PageBody>
      </>
    )
  }

  const now = new Date()

  return (
    <>
      <PageHeader
        title="Inbox"
        subtitle="Recent inbound messages across all channels. Click a row to open the related Contact and reply."
      />
      <PageBody>
        <nav
          aria-label="Inbox filters"
          className="mb-3 flex flex-wrap items-center gap-1"
        >
          {FILTERS.map((f) => {
            const href = f.value === 'all' ? '/inbox' : `/inbox?filter=${f.value}`
            const isActive = filter === f.value
            return (
              <Link
                key={f.value}
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={
                  isActive
                    ? 'rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white'
                    : 'rounded-md border border-neutral-200 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50'
                }
              >
                {f.label}
              </Link>
            )
          })}
        </nav>
        {items.length === 0 ? (
          <div className="rounded-lg border border-neutral-200 bg-white p-10 text-center shadow-sm">
            <p className="text-sm font-medium text-neutral-700">
              {filter === 'mine'
                ? 'Nothing assigned to you right now.'
                : filter === 'unassigned'
                  ? 'Nothing waiting to be picked up.'
                  : filter === 'snoozed'
                    ? 'Nothing snoozed for later.'
                    : 'No inbound messages yet.'}
            </p>
            <p className="mt-1 text-sm text-neutral-500">
              New WhatsApp, SMS, email, and web-chat messages will appear here
              as they land.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
            {items.map((item) => {
              const href = item.contactId ? `/contacts/${item.contactId}` : '/inbox'
              const channelLabel =
                item.channel && CHANNEL_LABEL[item.channel]
                  ? CHANNEL_LABEL[item.channel]
                  : (item.channel ?? 'Message')
              const snoozedNow =
                item.inboxSnoozedUntil &&
                item.inboxSnoozedUntil.getTime() > now.getTime()
              return (
                <li key={item.id} className="p-3 transition hover:bg-neutral-50">
                  <div className="flex items-start justify-between gap-4">
                    <Link href={href} className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-sm">
                        <span
                          className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100"
                          aria-hidden
                        >
                          <ChannelIcon channel={item.channel} />
                        </span>
                        <Badge tone="neutral">{channelLabel}</Badge>
                        <span className="truncate font-medium text-neutral-900">
                          {item.summary ?? 'Inbound message'}
                        </span>
                        {!item.contactId ? (
                          <Badge tone="warn">Unassigned</Badge>
                        ) : null}
                        {item.inboxAssigneeId ? (
                          <Badge tone="neutral">Assigned</Badge>
                        ) : null}
                        {snoozedNow ? (
                          <Badge tone="neutral">Snoozed</Badge>
                        ) : null}
                      </div>
                      {item.preview ? (
                        <p className="mt-1 truncate pl-8 text-sm text-neutral-700">
                          {item.preview}
                        </p>
                      ) : null}
                    </Link>
                    <time
                      className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                      dateTime={item.occurredAt.toISOString()}
                    >
                      {formatRelativeTime(item.occurredAt, now)}
                    </time>
                  </div>
                  <div className="mt-2 pl-8">
                    <InboxRowActions
                      interactionId={item.id}
                      contactId={item.contactId}
                    />
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </PageBody>
    </>
  )
}
