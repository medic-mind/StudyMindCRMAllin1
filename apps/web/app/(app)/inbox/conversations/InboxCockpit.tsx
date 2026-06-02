'use client'

// The Communication Centre cockpit — a Trengo-style 3-pane team inbox
// (folders/filters rail · conversation list · thread + composer · contact &
// ticket context). ADR 0020. CLAUDE.md §11, §20, §26.
//
// This replaces the old two-page flow (list page → separate detail page) so
// the experience matches Trengo: the list stays pinned, you read and reply in
// the centre, and contact/ticket context sits on the right — all updating live
// as webhooks land (useConversationStream) and as the agent acts. It is pure
// composition over the existing audited backend: the heavy interactive parts
// (reply, assign, labels, notes, tasks, close/reopen) are the same islands the
// detail page used, so every action still syncs back to Trengo.

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'

import { Avatar } from '@/components/ui/avatar'
import { InboxIcon, SearchIcon } from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { useConversationStream } from '@/lib/hooks/use-conversation-stream'
import { trpc } from '@/lib/trpc/client'

import {
  ChannelIcon,
  channelLabelFor,
  type CockpitConversation,
  type CockpitMe,
  type InboxChannel,
  type InboxFilter,
} from './cockpit-shared'
import { ContextPane } from './ContextPane'
import { ThreadPane } from './ThreadPane'

const FILTERS: ReadonlyArray<{ value: InboxFilter; label: string }> = [
  { value: 'active', label: 'Active' },
  { value: 'mine', label: 'Mine' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'snoozed', label: 'Snoozed' },
  { value: 'closed', label: 'Closed' },
]

const CHANNELS: ReadonlyArray<{ value: InboxChannel | null; label: string }> = [
  { value: null, label: 'All' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'sms', label: 'SMS' },
  { value: 'email', label: 'Email' },
  { value: 'web_chat', label: 'Web chat' },
]

export function InboxCockpit({
  me,
  initialFilter,
  initialChannel,
  initialSelectedId,
}: {
  me: CockpitMe
  initialFilter: InboxFilter
  initialChannel: InboxChannel | null
  initialSelectedId: string | null
}) {
  useConversationStream() // live: webhooks + CRM actions refresh the list

  const [filter, setFilter] = useState<InboxFilter>(initialFilter)
  const [channel, setChannel] = useState<InboxChannel | null>(initialChannel)
  const [unansweredOnly, setUnansweredOnly] = useState(false)
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [showContext, setShowContext] = useState(true)

  // Debounce the search box so typing stays smooth (matches the /mail client).
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim().toLowerCase()), 200)
    return () => clearTimeout(t)
  }, [rawQuery])

  const list = trpc.inbox.conversations.list.useQuery(
    { filter, channel: channel ?? null, limit: 100 },
    { refetchOnWindowFocus: true },
  )

  const allItems = useMemo<CockpitConversation[]>(
    () => (list.data?.items ?? []) as CockpitConversation[],
    [list.data],
  )

  // Client-side narrowing over the loaded page: search + "unanswered" toggle.
  // Server-side full-text search across the whole inbox is a follow-up; this
  // keeps the loaded set instant to filter, the way Trengo's box feels.
  const items = useMemo(() => {
    let rows = allItems
    if (unansweredOnly) rows = rows.filter((c) => c.unreadCount > 0)
    if (query) {
      rows = rows.filter((c) => {
        const hay = [c.contactName ?? '', c.subject ?? '', ...(c.tags ?? [])]
          .join(' ')
          .toLowerCase()
        return hay.includes(query)
      })
    }
    return rows
  }, [allItems, unansweredOnly, query])

  // Keep the URL shareable (?c=…) without a server round-trip, and clear it
  // when nothing is selected. Deep links are read on the server and arrive as
  // `initialSelectedId`.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const url = new URL(window.location.href)
    if (selectedId) url.searchParams.set('c', selectedId)
    else url.searchParams.delete('c')
    window.history.replaceState(null, '', url.toString())
  }, [selectedId])

  // Keyboard navigation (j/k like the /mail client). Inert while typing.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      const typing =
        !!t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      if (typing) {
        if (e.key === 'Escape') t.blur()
        return
      }
      const idx = selectedId ? items.findIndex((i) => i.id === selectedId) : -1
      const openAt = (i: number) => {
        const it = items[i]
        if (it) setSelectedId(it.id)
      }
      switch (e.key) {
        case 'j':
        case 'ArrowDown':
          e.preventDefault()
          openAt(Math.min(items.length - 1, idx + 1))
          break
        case 'k':
        case 'ArrowUp':
          e.preventDefault()
          openAt(idx <= 0 ? 0 : idx - 1)
          break
        case '/':
          e.preventDefault()
          document.getElementById('inbox-search')?.focus()
          break
        case 'Escape':
          setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selectedId])

  const forbidden = (list.error?.data as { code?: string } | null | undefined)?.code === 'FORBIDDEN'

  return (
    <div className="flex h-[calc(100vh-var(--shell-topbar-height))] overflow-hidden bg-neutral-50">
      <FoldersRail
        filter={filter}
        channel={channel}
        onFilter={(f) => {
          setFilter(f)
          setSelectedId(null)
        }}
        onChannel={(c) => {
          setChannel(c)
          setSelectedId(null)
        }}
      />

      {/* Conversation list */}
      <div className="flex w-[22rem] shrink-0 flex-col border-r border-neutral-200 bg-white">
        <div className="border-b border-neutral-200 p-2">
          <div className="relative">
            <SearchIcon
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <Input
              id="inbox-search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search this view…   ( / )"
              aria-label="Search conversations"
              className="h-9 pl-8"
            />
          </div>
          <div className="mt-2 flex items-center gap-1 text-xs">
            <button
              type="button"
              onClick={() => setUnansweredOnly(false)}
              aria-pressed={!unansweredOnly}
              className={
                !unansweredOnly
                  ? 'rounded-md bg-neutral-900 px-2 py-1 font-medium text-white'
                  : 'rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100'
              }
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setUnansweredOnly(true)}
              aria-pressed={unansweredOnly}
              className={
                unansweredOnly
                  ? 'rounded-md bg-neutral-900 px-2 py-1 font-medium text-white'
                  : 'rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100'
              }
            >
              Unanswered
            </button>
            <span className="ml-auto pr-1 text-neutral-400">
              {items.length}
              {list.isFetching ? ' · syncing…' : ''}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {forbidden ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              You need a staff role to view conversations.
            </div>
          ) : list.isLoading ? (
            <ListSkeleton />
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              {query || unansweredOnly ? 'Nothing matches this view.' : emptyCopyFor(filter)}
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((c) => (
                <ConversationRow
                  key={c.id}
                  item={c}
                  active={selectedId === c.id}
                  now={new Date()}
                  onOpen={() => setSelectedId(c.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Thread + composer */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-neutral-50/40">
        {selectedId ? (
          <ThreadPane
            key={selectedId}
            conversationId={selectedId}
            showContext={showContext}
            onToggleContext={() => setShowContext((s) => !s)}
            onClose={() => setSelectedId(null)}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Contact + ticket context */}
      {selectedId && showContext ? <ContextPane conversationId={selectedId} me={me} /> : null}
    </div>
  )
}

function emptyCopyFor(filter: InboxFilter): string {
  switch (filter) {
    case 'mine':
      return 'No conversations assigned to you.'
    case 'unassigned':
      return 'Nothing waiting to be picked up.'
    case 'closed':
      return 'No closed conversations yet.'
    case 'snoozed':
      return 'No conversations snoozed for later.'
    default:
      return 'No active conversations.'
  }
}

// -----------------------------------------------------------------------------
// Folders / filters rail
// -----------------------------------------------------------------------------

function FoldersRail({
  filter,
  channel,
  onFilter,
  onChannel,
}: {
  filter: InboxFilter
  channel: InboxChannel | null
  onFilter: (f: InboxFilter) => void
  onChannel: (c: InboxChannel | null) => void
}) {
  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-3 md:flex">
      <div className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold text-neutral-900">
        <InboxIcon size={16} className="text-neutral-500" />
        Inbox
      </div>

      <nav aria-label="Views" className="flex flex-col gap-0.5">
        {FILTERS.map((f) => (
          <RailItem
            key={f.value}
            label={f.label}
            active={filter === f.value}
            onClick={() => onFilter(f.value)}
          />
        ))}
      </nav>

      <div>
        <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          Channels
        </h2>
        <nav aria-label="Channels" className="flex flex-col gap-0.5">
          {CHANNELS.map((c) => (
            <RailItem
              key={c.label}
              label={c.label}
              icon={c.value ? <ChannelIcon channel={c.value} size={13} /> : null}
              active={channel === c.value}
              onClick={() => onChannel(c.value)}
            />
          ))}
        </nav>
      </div>

      <div className="mt-auto">
        <Link
          href="/inbox/suggestions"
          className="block rounded-md px-2.5 py-1.5 text-xs text-primary-700 hover:bg-neutral-100"
        >
          AI suggestions →
        </Link>
      </div>
    </aside>
  )
}

function RailItem({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon?: React.ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={
        active
          ? 'flex items-center gap-2 truncate rounded-md bg-primary-100 px-2.5 py-1.5 text-left text-sm font-medium text-primary-800'
          : 'flex items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100'
      }
    >
      {icon ? <span className="shrink-0">{icon}</span> : null}
      {label}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Conversation list row
// -----------------------------------------------------------------------------

function ConversationRow({
  item,
  active,
  now,
  onOpen,
}: {
  item: CockpitConversation
  active: boolean
  now: Date
  onOpen: () => void
}) {
  const unread = item.unreadCount > 0
  const who = item.contactName ?? (item.contactId ? 'Contact' : 'Unmatched')
  const replyWindowOpen =
    item.replyDeadlineAt && new Date(item.replyDeadlineAt).getTime() > now.getTime()
  return (
    <li
      className={`group relative flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors ${
        active ? 'bg-primary-50' : 'hover:bg-neutral-50'
      }`}
      onClick={onOpen}
    >
      {unread ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary-500" />
      ) : null}
      <div className="relative shrink-0">
        <Avatar name={who} size={32} />
        <span
          aria-hidden
          className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-white ring-1 ring-neutral-200"
        >
          <ChannelIcon channel={item.channel} size={11} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span
            className={`truncate text-sm ${
              unread ? 'font-semibold text-neutral-900' : 'font-medium text-neutral-700'
            }`}
          >
            {who}
          </span>
          <time
            className="shrink-0 text-[11px] tabular-nums text-neutral-400"
            dateTime={item.lastMessageAt.toISOString()}
          >
            {formatRelativeTime(item.lastMessageAt, now)}
          </time>
        </div>
        {item.subject ? (
          <div
            className={`truncate text-[13px] ${
              unread ? 'font-medium text-neutral-800' : 'text-neutral-600'
            }`}
          >
            {item.subject}
          </div>
        ) : (
          <div className="truncate text-[13px] text-neutral-400">
            {channelLabelFor(item.channel)}
          </div>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-1">
          {item.unreadCount > 0 ? (
            <span className="rounded-full bg-primary-100 px-1.5 text-[10px] font-semibold text-primary-700">
              {item.unreadCount}
            </span>
          ) : null}
          {item.status === 'closed' ? (
            <span className="rounded bg-neutral-100 px-1 text-[10px] text-neutral-500">Closed</span>
          ) : null}
          {item.status === 'snoozed' ? (
            <span className="rounded bg-amber-50 px-1 text-[10px] text-amber-700">Snoozed</span>
          ) : null}
          {item.channel === 'whatsapp' && item.replyDeadlineAt ? (
            <span
              className={`rounded px-1 text-[10px] ${
                replyWindowOpen ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
              }`}
            >
              {replyWindowOpen ? '24h open' : '24h closed'}
            </span>
          ) : null}
          {(item.tags ?? []).slice(0, 2).map((t) => (
            <span
              key={t}
              className="rounded-full border border-neutral-200 bg-neutral-50 px-1.5 text-[10px] text-neutral-600"
            >
              {t}
            </span>
          ))}
          {item.assigneeName ? (
            <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-neutral-500">
              <Avatar name={item.assigneeName} size={14} />
            </span>
          ) : null}
        </div>
      </div>
    </li>
  )
}

function ListSkeleton() {
  return (
    <ul className="divide-y divide-neutral-100">
      {Array.from({ length: 7 }).map((_, i) => (
        <li key={i} className="flex items-start gap-2.5 px-3 py-3">
          <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-neutral-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center text-neutral-400">
      <InboxIcon size={42} className="text-neutral-200" />
      <p className="mt-3 text-sm font-medium text-neutral-500">
        Select a conversation to read and reply
      </p>
      <p className="mt-1 max-w-sm text-xs text-neutral-400">
        Every WhatsApp, SMS, web-chat and email thread lands here and stays in sync with Trengo —
        reply from the app and it sends on the same channel.
      </p>
    </div>
  )
}
