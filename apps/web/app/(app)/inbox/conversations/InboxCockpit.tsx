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
import { toast } from 'sonner'

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

// Trengo-style folders: Inbox (New = waiting unassigned, Assigned, Closed,
// Snoozed) + Personal (Assigned to me). `countKey` maps to
// inbox.conversations.counts for the rail badges ("New 4 · Assigned 36").
const INBOX_FILTERS: ReadonlyArray<{
  value: InboxFilter
  label: string
  countKey: 'newCount' | 'assigned' | 'mine' | 'closed' | 'snoozed' | null
}> = [
  { value: 'unassigned', label: 'New', countKey: 'newCount' },
  { value: 'assigned', label: 'Assigned', countKey: 'assigned' },
  { value: 'active', label: 'All open', countKey: null },
  { value: 'snoozed', label: 'Snoozed', countKey: 'snoozed' },
  { value: 'closed', label: 'Closed', countKey: 'closed' },
]
const PERSONAL_FILTERS: typeof INBOX_FILTERS = [
  { value: 'mine', label: 'Assigned to me', countKey: 'mine' },
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
  const [tag, setTag] = useState<string | null>(null)
  const [unansweredOnly, setUnansweredOnly] = useState(false)
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId)
  const [showContext, setShowContext] = useState(true)
  // Multi-select for bulk triage (Trengo parity). A Set of conversation ids.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // The details pane is a static column on xl but an overlay below it; default
  // it CLOSED on small screens so opening a conversation doesn't immediately
  // cover the thread. Runs once on mount (client-only → no hydration mismatch).
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1280) setShowContext(false)
  }, [])

  // Debounce the search box so typing stays smooth (matches the /mail client).
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [rawQuery])

  const list = trpc.inbox.conversations.list.useQuery(
    { filter, channel: channel ?? null, tag: tag ?? null, limit: 100 },
    { refetchOnWindowFocus: true },
  )

  // Whole-inbox server search (Trengo parity): once the query is ≥2 chars we
  // search EVERY conversation, not just the loaded page. Below that we show the
  // filtered folder list.
  const searching = query.length >= 2
  const searchResults = trpc.inbox.conversations.search.useQuery(
    { query, limit: 40 },
    { enabled: searching, staleTime: 10_000, retry: false },
  )

  const allItems = useMemo<CockpitConversation[]>(
    () => (list.data?.items ?? []) as CockpitConversation[],
    [list.data],
  )

  // When searching, the list IS the server search result (whole inbox);
  // otherwise it's the folder list, optionally narrowed by the "unanswered"
  // toggle. The unanswered toggle still applies on top of search.
  const items = useMemo(() => {
    let rows = searching
      ? ((searchResults.data?.items ?? []) as CockpitConversation[])
      : allItems
    if (unansweredOnly) rows = rows.filter((c) => c.unreadCount > 0)
    return rows
  }, [searching, searchResults.data, allItems, unansweredOnly])

  const utils = trpc.useUtils()
  const bulk = trpc.inbox.conversations.bulk.useMutation({
    onSuccess: (res) => {
      const n = res.succeeded
      toast.success(`${n} conversation${n === 1 ? '' : 's'} updated`)
      setSelectedIds(new Set())
      void utils.inbox.conversations.list.invalidate()
      void utils.inbox.conversations.counts.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Bulk action failed'),
  })
  const runBulk = (action: 'markRead' | 'close' | 'snooze' | 'unsnooze', minutes?: number) => {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    bulk.mutate({ conversationIds: ids, action, ...(minutes ? { minutes } : {}) })
  }
  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allShownSelected = items.length > 0 && items.every((c) => selectedIds.has(c.id))
  const toggleSelectAll = () =>
    setSelectedIds(allShownSelected ? new Set() : new Set(items.map((c) => c.id)))
  // Clear selection when the folder/filter/search changes (the rows changed).
  useEffect(() => {
    setSelectedIds(new Set())
  }, [filter, channel, tag, searching])

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
        tag={tag}
        onFilter={(f) => {
          setFilter(f)
          setSelectedId(null)
        }}
        onChannel={(c) => {
          setChannel(c)
          setSelectedId(null)
        }}
        onTag={(t) => {
          setTag(t)
          setSelectedId(null)
        }}
      />

      {/* Conversation list — full-width on mobile; on a phone we show EITHER
          the list or the open thread (master-detail), never both squeezed. */}
      <div
        className={`${selectedId ? 'hidden lg:flex' : 'flex'} w-full shrink-0 flex-col border-r border-neutral-200 bg-white lg:w-[22rem]`}
      >
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
              {searching && searchResults.isFetching
                ? ' · searching…'
                : list.isFetching && !searching
                  ? ' · syncing…'
                  : ''}
            </span>
          </div>
          {/* Bulk-select header + actions (Trengo parity). Shows once a row
              is ticked; markRead/snooze are instant, close loops Trengo. */}
          {items.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              <label className="flex items-center gap-1.5 text-neutral-500">
                <input
                  type="checkbox"
                  checked={allShownSelected}
                  onChange={toggleSelectAll}
                  aria-label="Select all conversations"
                />
                {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select'}
              </label>
              {selectedIds.size > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={bulk.isPending}
                    onClick={() => runBulk('markRead')}
                    className="rounded border border-neutral-200 bg-white px-2 py-0.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Mark read
                  </button>
                  <button
                    type="button"
                    disabled={bulk.isPending}
                    onClick={() => runBulk('snooze', 60 * 24)}
                    className="rounded border border-neutral-200 bg-white px-2 py-0.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Snooze 1d
                  </button>
                  <button
                    type="button"
                    disabled={bulk.isPending}
                    onClick={() => {
                      if (window.confirm(`Close ${selectedIds.size} conversation(s) in Trengo?`)) {
                        runBulk('close')
                      }
                    }}
                    className="rounded border border-neutral-200 bg-white px-2 py-0.5 text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={() => setSelectedIds(new Set())}
                    className="text-neutral-400 hover:text-neutral-700"
                  >
                    Clear
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto">
          {forbidden ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              You need a staff role to view conversations.
            </div>
          ) : list.isLoading && !searching ? (
            <ListSkeleton />
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              {searching
                ? searchResults.isFetching
                  ? 'Searching…'
                  : `No conversations match “${query}”.`
                : unansweredOnly
                  ? 'Nothing unanswered in this view.'
                  : emptyCopyFor(filter)}
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((c) => (
                <ConversationRow
                  key={c.id}
                  item={c}
                  active={selectedId === c.id}
                  selected={selectedIds.has(c.id)}
                  onToggleSelect={() => toggleSelect(c.id)}
                  now={new Date()}
                  onOpen={() => setSelectedId(c.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Thread + composer — hidden on mobile until a conversation is opened. */}
      <div
        className={`${selectedId ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col overflow-hidden bg-neutral-50/40`}
      >
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

      {/* Contact + ticket context — static column on xl, slide-over drawer
          below it (so Assign / Snooze / Labels / Task are reachable on any
          screen, not hidden off-canvas). */}
      {selectedId && showContext ? (
        <ContextPane
          conversationId={selectedId}
          me={me}
          onClose={() => setShowContext(false)}
        />
      ) : null}
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
  tag,
  onFilter,
  onChannel,
  onTag,
}: {
  filter: InboxFilter
  channel: InboxChannel | null
  tag: string | null
  onFilter: (f: InboxFilter) => void
  onChannel: (c: InboxChannel | null) => void
  onTag: (t: string | null) => void
}) {
  // Trengo labels across the workspace — synced from tickets onto the
  // Conversation heads; clicking one narrows the list server-side.
  const tags = trpc.inbox.conversations.tags.useQuery(undefined, {
    staleTime: 60_000,
    retry: false,
  })
  // Folder counts ("New 4 · Assigned 36"), refreshed with the list.
  const counts = trpc.inbox.conversations.counts.useQuery(undefined, {
    refetchInterval: 60_000,
    retry: false,
  })
  const badge = (key: (typeof INBOX_FILTERS)[number]['countKey']): number | null =>
    key && counts.data ? counts.data[key] : null
  return (
    <aside className="hidden w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-3 md:flex">
      <div className="flex items-center gap-2 px-1 pt-1 text-sm font-semibold text-neutral-900">
        <InboxIcon size={16} className="text-neutral-500" />
        Inbox
      </div>

      <nav aria-label="Views" className="flex flex-col gap-0.5">
        {INBOX_FILTERS.map((f) => (
          <RailItem
            key={f.value}
            label={f.label}
            count={badge(f.countKey)}
            active={filter === f.value}
            onClick={() => onFilter(f.value)}
          />
        ))}
      </nav>

      <div>
        <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          Personal
        </h2>
        <nav aria-label="Personal" className="flex flex-col gap-0.5">
          {PERSONAL_FILTERS.map((f) => (
            <RailItem
              key={f.value}
              label={f.label}
              count={badge(f.countKey)}
              active={filter === f.value}
              onClick={() => onFilter(f.value)}
            />
          ))}
        </nav>
      </div>

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

      {(tags.data?.length ?? 0) > 0 ? (
        <div>
          <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Labels
          </h2>
          <nav aria-label="Labels" className="flex flex-col gap-0.5">
            {tag !== null ? (
              <RailItem label="Clear label filter" active={false} onClick={() => onTag(null)} />
            ) : null}
            {tags.data!.slice(0, 30).map((t) => (
              <RailItem
                key={t.name}
                label={t.name}
                count={t.count > 0 ? t.count : null}
                active={tag === t.name}
                onClick={() => onTag(tag === t.name ? null : t.name)}
              />
            ))}
          </nav>
        </div>
      ) : null}

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
  count = null,
  active,
  onClick,
}: {
  label: string
  icon?: React.ReactNode
  count?: number | null
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
      <span className="truncate">{label}</span>
      {count !== null && count > 0 ? (
        <span
          className={`ml-auto rounded-full px-1.5 text-[11px] font-medium tabular-nums ${
            active ? 'bg-primary-200 text-primary-900' : 'bg-neutral-200 text-neutral-700'
          }`}
        >
          {count > 999 ? '999+' : count}
        </span>
      ) : null}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Conversation list row
// -----------------------------------------------------------------------------

function ConversationRow({
  item,
  active,
  selected,
  onToggleSelect,
  now,
  onOpen,
}: {
  item: CockpitConversation
  active: boolean
  selected: boolean
  onToggleSelect: () => void
  now: Date
  onOpen: () => void
}) {
  const unread = item.unreadCount > 0
  const who = item.contactName ?? (item.contactId ? 'Contact' : 'Unmatched')
  const replyWindowOpen =
    item.replyDeadlineAt && new Date(item.replyDeadlineAt).getTime() > now.getTime()
  return (
    <li
      className={`group relative flex cursor-pointer items-start gap-2 px-3 py-2.5 transition-colors ${
        active ? 'bg-primary-50' : selected ? 'bg-primary-50/40' : 'hover:bg-neutral-50'
      }`}
      onClick={onOpen}
    >
      {unread ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary-500" />
      ) : null}
      {/* Multi-select checkbox — click doesn't open the thread. */}
      <input
        type="checkbox"
        checked={selected}
        onClick={(e) => e.stopPropagation()}
        onChange={onToggleSelect}
        aria-label={`Select conversation with ${who}`}
        className="mt-2.5 shrink-0"
      />
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
        {item.lastMessagePreview ? (
          <div
            className={`truncate text-[13px] ${
              unread ? 'font-medium text-neutral-800' : 'text-neutral-600'
            }`}
          >
            {item.lastMessagePreview}
          </div>
        ) : item.subject ? (
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
        {item.status !== 'open' ||
        (item.channel === 'whatsapp' && item.replyDeadlineAt && !replyWindowOpen) ||
        (item.tags ?? []).length > 0 ||
        item.assigneeName ? (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {item.status === 'closed' ? (
              <span className="rounded px-1 text-[10px] font-medium text-neutral-400">Closed</span>
            ) : null}
            {item.status === 'snoozed' ? (
              <span className="rounded px-1 text-[10px] font-medium text-warning-700">Snoozed</span>
            ) : null}
            {/* Only flag the WhatsApp window when it has CLOSED (actionable —
                you can no longer free-text). An open window is the norm. */}
            {item.channel === 'whatsapp' && item.replyDeadlineAt && !replyWindowOpen ? (
              <span className="rounded bg-warning-50 px-1 text-[10px] font-medium text-warning-700">
                24h window closed
              </span>
            ) : null}
            {(item.tags ?? []).slice(0, 2).map((t) => (
              <span
                key={t}
                className="truncate rounded-full bg-neutral-100 px-1.5 text-[10px] text-neutral-600"
              >
                {t}
              </span>
            ))}
            {item.assigneeName ? (
              <span
                className="ml-auto inline-flex items-center"
                title={`Assigned to ${item.assigneeName}`}
              >
                <Avatar name={item.assigneeName} size={16} />
              </span>
            ) : null}
          </div>
        ) : null}
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
