'use client'

// The /mail email client (ADR 0021). A Gmail-class layout: an icon folder rail
// with a Compose pill, a full-width single-line message list with hover row
// actions, a full-width conversation view, and a docked composer. Single main
// pane (list XOR conversation) like Gmail. Chrome is neutral; the exact Gmail
// blue `gmail` accent + amber stars are a deliberate scoped comms theme
// (CLAUDE.md §37, mirroring the Trengo inbox/* exception) so
// it reads like Gmail rather than the product purple. All actions go through the
// audited tRPC mutations; the live mailbox is the source of truth. §4, §14, §26.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import {
  AlertTriangleIcon,
  ArchiveIcon,
  BellIcon,
  CalendarIcon,
  CheckIcon,
  ChevronLeftIcon,
  FileTextIcon,
  ForwardIcon,
  InboxIcon,
  MailIcon,
  PencilIcon,
  RepeatIcon,
  ReplyIcon,
  SearchIcon,
  SendIcon,
  SlidersIcon,
  StarIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from '@/components/ui/icon'
import { Textarea } from '@/components/ui/textarea'
import { displayMessageBody } from '@/lib/format/html-text'
import { useConversationStream } from '@/lib/hooks/use-conversation-stream'
import { trpc } from '@/lib/trpc/client'

interface AccountOption {
  id: string
  address: string
  displayName: string | null
  signatureHtml: string | null
}

function signatureText(account: AccountOption | undefined): string {
  const html = account?.signatureHtml
  if (!html) return ''
  return displayMessageBody(html)?.trim() ?? ''
}

// Gmail-style date: today → time, this year → "12 Jun", older → "12/06/24".
function gmailDate(d: Date, now: Date): string {
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) {
    return d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit' })
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
  }
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

// The /mail rail folders. Membership is derived from each thread's live Gmail
// label set server-side (mail.threads.list), so every folder mirrors the
// matching Gmail view exactly (§14 label-mirror). 'drafts' is Gmail-API-backed.
type Folder =
  | 'inbox'
  | 'snoozed'
  | 'important'
  | 'sent'
  | 'drafts'
  | 'starred'
  | 'spam'
  | 'all'
  | 'archived'
  | 'trash'

// Gmail's inbox category tabs, shown as a strip above the Inbox list.
type InboxTab = 'primary' | 'social' | 'promotions' | 'updates' | 'forums'

const FOLDERS: ReadonlyArray<{ key: Folder; label: string; Icon: typeof InboxIcon }> = [
  { key: 'inbox', label: 'Inbox', Icon: InboxIcon },
  { key: 'snoozed', label: 'Snoozed', Icon: CalendarIcon },
  { key: 'important', label: 'Important', Icon: BellIcon },
  { key: 'sent', label: 'Sent', Icon: SendIcon },
  { key: 'drafts', label: 'Drafts', Icon: FileTextIcon },
  { key: 'starred', label: 'Starred', Icon: StarIcon },
  { key: 'spam', label: 'Spam', Icon: AlertTriangleIcon },
  { key: 'all', label: 'All mail', Icon: MailIcon },
  { key: 'archived', label: 'Archived', Icon: ArchiveIcon },
  { key: 'trash', label: 'Trash', Icon: Trash2Icon },
]

const INBOX_TABS: ReadonlyArray<{ key: InboxTab; label: string }> = [
  { key: 'primary', label: 'Primary' },
  { key: 'social', label: 'Social' },
  { key: 'promotions', label: 'Promotions' },
  { key: 'updates', label: 'Updates' },
  { key: 'forums', label: 'Forums' },
]

export function MailWorkspace({ accounts }: { accounts: AccountOption[] }) {
  const utils = trpc.useUtils()
  useConversationStream()
  const [accountId, setAccountId] = useState<string | null>(null)
  const [folder, setFolder] = useState<Folder>('inbox')
  // The active Gmail inbox category tab (only meaningful when folder === 'inbox').
  const [tab, setTab] = useState<InboxTab>('primary')
  // A selected Gmail label folder (Gmail's label sidebar). When set, the list
  // shows all mail carrying that label; folder selection is suspended.
  const [label, setLabel] = useState<string | null>(null)
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [composing, setComposing] = useState(false)
  const [resumeDraft, setResumeDraft] = useState<DraftInitial | null>(null)
  const [showFilters, setShowFilters] = useState(false)
  const [searchFocused, setSearchFocused] = useState(false)
  const [recent, setRecent] = useState<string[]>([])

  useEffect(() => {
    try {
      const raw = localStorage.getItem('mail.recentSearches')
      if (raw) setRecent(JSON.parse(raw) as string[])
    } catch {
      /* ignore */
    }
  }, [])

  const runSearch = useCallback((q: string) => {
    const trimmed = q.trim()
    setRawQuery(trimmed)
    setQuery(trimmed)
    setShowFilters(false)
    setSearchFocused(false)
    if (trimmed.length === 0) return
    setRecent((cur) => {
      const next = [trimmed, ...cur.filter((x) => x !== trimmed)].slice(0, 8)
      try {
        localStorage.setItem('mail.recentSearches', JSON.stringify(next))
      } catch {
        /* ignore */
      }
      return next
    })
  }, [])

  // Drafts is its own (Gmail-backed) list, not a Conversation-head filter.
  const showDrafts = folder === 'drafts' && !label
  const draftsAccountId = accountId ?? accounts[0]?.id ?? null

  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [rawQuery])

  // The Gmail-native folder to query: a label folder spans all labelled mail;
  // the Inbox resolves to its active category tab (Primary by default); every
  // other folder maps 1:1.
  const listFilter: InboxTab | Folder = label
    ? 'all'
    : folder === 'inbox'
      ? tab
      : folder === 'drafts'
        ? 'inbox'
        : folder

  // A typed query runs a real Gmail search (full body + operators) scoped to the
  // selected account (or the first when "All accounts" is chosen).
  const searching = query.length > 0 && !showDrafts && !!draftsAccountId
  const threads = trpc.mail.threads.list.useQuery(
    {
      mailAccountId: accountId,
      filter: listFilter,
      label: label,
      limit: 50,
    },
    { enabled: !showDrafts && !searching },
  )
  const search = trpc.mail.threads.search.useQuery(
    { mailAccountId: draftsAccountId ?? '', q: query },
    { enabled: searching },
  )
  const items = useMemo(
    () => (searching ? (search.data?.items ?? []) : (threads.data?.items ?? [])),
    [searching, search.data, threads.data],
  )
  const listLoading = searching ? search.isLoading : threads.isLoading
  const labels = trpc.mail.labels.useQuery({ mailAccountId: accountId })
  // Gmail-style unread badges for Inbox + its category tabs, plus the Spam total.
  const counts = trpc.mail.folderCounts.useQuery({ mailAccountId: accountId })
  const syncNow = trpc.mail.syncNow.useMutation()

  const kbArchive = trpc.mail.thread.setArchived.useMutation()
  const kbRead = trpc.mail.thread.setRead.useMutation()
  const kbStar = trpc.mail.thread.setStarred.useMutation()
  const kbTrash = trpc.mail.thread.setTrashed.useMutation()

  const invalidateList = useCallback(() => {
    void utils.mail.threads.list.invalidate()
    void utils.mail.threads.search.invalidate()
  }, [utils])
  const refreshOpen = useCallback(() => {
    invalidateList()
    if (selectedId) void utils.inbox.conversations.get.invalidate({ conversationId: selectedId })
  }, [invalidateList, utils, selectedId])
  const kbdAction = useCallback(
    (p: Promise<unknown>, label: string) => {
      p.then(() => {
        toast.success(label)
        refreshOpen()
      }).catch((e) => toast.error(e instanceof Error ? e.message : 'Action failed'))
    },
    [refreshOpen],
  )

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
        case 'e':
          if (selectedId)
            kbdAction(kbArchive.mutateAsync({ conversationId: selectedId, archived: true }), 'Archived')
          break
        case 'u':
          if (selectedId)
            kbdAction(kbRead.mutateAsync({ conversationId: selectedId, read: false }), 'Marked unread')
          break
        case 's':
          if (selectedId)
            kbdAction(kbStar.mutateAsync({ conversationId: selectedId, starred: true }), 'Starred')
          break
        case '#':
          if (selectedId)
            kbdAction(kbTrash.mutateAsync({ conversationId: selectedId, trashed: true }), 'Moved to Trash')
          break
        case 'r':
          e.preventDefault()
          document.getElementById('mail-reply')?.focus()
          break
        case '/':
          e.preventDefault()
          document.getElementById('mail-search')?.focus()
          break
        case 'c':
          setComposing(true)
          break
        case 'Escape':
          if (composing) setComposing(false)
          else setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selectedId, composing, kbdAction, kbArchive, kbRead, kbStar, kbTrash])

  const allChecked = items.length > 0 && checked.size === items.length
  const toggleAll = () =>
    setChecked(allChecked ? new Set() : new Set(items.map((i) => i.id)))

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Rail */}
      <aside className="flex w-60 shrink-0 flex-col gap-1 overflow-y-auto border-r border-neutral-200 bg-neutral-50 p-3">
        <div className="mb-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setComposing(true)}
            className="inline-flex w-fit items-center gap-3 rounded-2xl bg-gmail-600 py-3 pl-4 pr-6 text-sm font-medium text-white shadow-sm transition-colors hover:bg-gmail-700"
          >
            <PencilIcon size={18} /> Compose
          </button>
          {/* Force a Gmail sync — the safety net that converges the CRM onto
              Gmail's current state on demand (the gmail/sync cron also runs
              every 10 min). */}
          <button
            type="button"
            title="Sync from Gmail"
            aria-label="Sync from Gmail"
            disabled={syncNow.isPending}
            onClick={() => {
              syncNow
                .mutateAsync()
                .then((r) => {
                  toast.success(
                    r.connected > 0 ? 'Syncing from Gmail…' : 'No Gmail account connected',
                  )
                  setTimeout(() => {
                    void utils.mail.threads.list.invalidate()
                    void utils.mail.labels.invalidate()
                    void utils.mail.folderCounts.invalidate()
                  }, 1500)
                })
                .catch((e) => toast.error(e instanceof Error ? e.message : 'Sync failed'))
            }}
            className="rounded-full border border-neutral-300 bg-white p-2 text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
          >
            <RepeatIcon size={16} className={syncNow.isPending ? 'animate-spin' : ''} />
          </button>
        </div>

        <nav aria-label="Folders" className="flex flex-col gap-0.5">
          {FOLDERS.map(({ key, label: folderLabel, Icon }) => {
            const active = folder === key && !label
            const badge =
              key === 'inbox'
                ? (counts.data?.inbox ?? 0)
                : key === 'spam'
                  ? (counts.data?.spam ?? 0)
                  : 0
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setFolder(key)
                  setLabel(null)
                  setSelectedId(null)
                  setChecked(new Set())
                }}
                aria-current={active ? 'true' : undefined}
                className={`flex items-center gap-3 rounded-full px-4 py-1.5 text-left text-sm transition-colors ${
                  active
                    ? 'bg-gmail-100 font-semibold text-gmail-900'
                    : 'text-neutral-700 hover:bg-neutral-200/60'
                }`}
              >
                <Icon size={16} className={active ? 'text-gmail-700' : 'text-neutral-500'} />
                <span className="flex-1">{folderLabel}</span>
                {badge > 0 ? (
                  <span
                    className={`shrink-0 text-xs tabular-nums ${
                      active ? 'text-gmail-700' : 'text-neutral-500'
                    }`}
                  >
                    {badge}
                  </span>
                ) : null}
              </button>
            )
          })}
        </nav>

        {(labels.data?.length ?? 0) > 0 ? (
          <div className="mt-4">
            <h2 className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              Labels
            </h2>
            <nav aria-label="Labels" className="flex flex-col gap-0.5">
              {(labels.data ?? []).map((l) => {
                const active = label === l.name
                return (
                  <button
                    key={l.name}
                    type="button"
                    onClick={() => {
                      setLabel(l.name)
                      setSelectedId(null)
                      setChecked(new Set())
                    }}
                    aria-current={active ? 'true' : undefined}
                    className={`flex items-center gap-3 rounded-full px-4 py-1.5 text-left text-sm transition-colors ${
                      active
                        ? 'bg-gmail-100 font-semibold text-gmail-900'
                        : 'text-neutral-700 hover:bg-neutral-200/60'
                    }`}
                    title={`${l.count} conversation${l.count === 1 ? '' : 's'}`}
                  >
                    <TagIcon
                      size={15}
                      className={active ? 'text-gmail-700' : 'text-neutral-500'}
                    />
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                    <span className="shrink-0 text-[11px] text-neutral-400">{l.count}</span>
                  </button>
                )
              })}
            </nav>
          </div>
        ) : null}

        <div className="mt-4">
          <h2 className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Accounts
          </h2>
          <nav aria-label="Accounts" className="flex flex-col gap-0.5">
            <button
              type="button"
              onClick={() => {
                setAccountId(null)
                setSelectedId(null)
                setChecked(new Set())
              }}
              className={`truncate rounded-full px-4 py-1.5 text-left text-sm transition-colors ${
                accountId === null
                  ? 'bg-gmail-100 font-medium text-gmail-900'
                  : 'text-neutral-700 hover:bg-neutral-200/60'
              }`}
            >
              All accounts
            </button>
            {accounts.map((a) => (
              <button
                key={a.id}
                type="button"
                title={a.address}
                onClick={() => {
                  setAccountId(a.id)
                  setSelectedId(null)
                  setChecked(new Set())
                }}
                className={`truncate rounded-full px-4 py-1.5 text-left text-sm transition-colors ${
                  accountId === a.id
                    ? 'bg-gmail-100 font-medium text-gmail-900'
                    : 'text-neutral-700 hover:bg-neutral-200/60'
                }`}
              >
                {a.displayName ?? a.address}
              </button>
            ))}
            {accounts.length === 0 ? (
              <a
                href="/settings/email-accounts"
                className="rounded-full px-4 py-1.5 text-sm text-gmail-700 hover:bg-neutral-200/60"
              >
                Connect an account…
              </a>
            ) : null}
          </nav>
        </div>
      </aside>

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Search bar */}
        <div className="border-b border-neutral-200 px-4 py-2.5">
          <div className="relative mx-auto max-w-3xl">
            <SearchIcon
              size={18}
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500"
            />
            <input
              id="mail-search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runSearch(rawQuery)
              }}
              placeholder="Search mail (try from:jane has:attachment is:unread)"
              aria-label="Search mail"
              className="h-11 w-full rounded-lg border border-transparent bg-neutral-100 pl-11 pr-20 text-sm text-neutral-900 placeholder:text-neutral-500 focus:border-gmail-300 focus:bg-white focus:outline-none focus:ring-2 focus:ring-gmail-100"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
              {rawQuery ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => runSearch('')}
                  className="rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700"
                >
                  <XIcon size={15} />
                </button>
              ) : null}
              <button
                type="button"
                aria-label="Search filters"
                aria-expanded={showFilters}
                onClick={() => setShowFilters((v) => !v)}
                className={`rounded p-1 hover:bg-neutral-200 ${showFilters ? 'text-gmail-700' : 'text-neutral-400 hover:text-neutral-700'}`}
              >
                <SlidersIcon size={16} />
              </button>
            </div>

            {/* Recent searches */}
            {searchFocused && !showFilters && rawQuery.length === 0 && recent.length > 0 ? (
              <div className="absolute left-0 right-0 top-12 z-20 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
                <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                  Recent searches
                </p>
                {recent.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => runSearch(r)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    <SearchIcon size={14} className="text-neutral-400" /> {r}
                  </button>
                ))}
              </div>
            ) : null}

            {/* Advanced filter panel */}
            {showFilters ? (
              <AdvancedSearchPanel
                onApply={(q) => runSearch(q)}
                onClose={() => setShowFilters(false)}
              />
            ) : null}
          </div>
        </div>

        {selectedId ? (
          <ConversationView
            conversationId={selectedId}
            accounts={accounts}
            onBack={() => setSelectedId(null)}
            onChanged={invalidateList}
          />
        ) : showDrafts ? (
          <DraftsList
            accountId={draftsAccountId}
            onResume={(d) => setResumeDraft(d)}
          />
        ) : (
          <>
            {/* Gmail inbox category tabs (Primary / Social / Promotions / …).
                Shown only on the Inbox folder; each switches the list filter to
                that category exactly like Gmail's tabbed inbox. */}
            {folder === 'inbox' && !label && !searching ? (
              <div className="flex items-stretch border-b border-neutral-200">
                {INBOX_TABS.map((t) => {
                  const activeTab = tab === t.key
                  const badge =
                    t.key === 'primary'
                      ? (counts.data?.primary ?? 0)
                      : t.key === 'social'
                        ? (counts.data?.social ?? 0)
                        : t.key === 'promotions'
                          ? (counts.data?.promotions ?? 0)
                          : t.key === 'updates'
                            ? (counts.data?.updates ?? 0)
                            : (counts.data?.forums ?? 0)
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => {
                        setTab(t.key)
                        setSelectedId(null)
                        setChecked(new Set())
                      }}
                      aria-current={activeTab ? 'true' : undefined}
                      className={`flex min-w-0 items-center gap-2 border-b-2 px-4 py-2 text-sm transition-colors ${
                        activeTab
                          ? 'border-gmail-600 font-medium text-gmail-700'
                          : 'border-transparent text-neutral-500 hover:bg-neutral-50 hover:text-neutral-700'
                      }`}
                    >
                      <span className="truncate">{t.label}</span>
                      {badge > 0 ? (
                        <span className="shrink-0 rounded-full bg-gmail-100 px-1.5 text-[11px] font-medium text-gmail-700">
                          {badge}
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : null}

            {/* Toolbar */}
            <div className="flex items-center gap-1 border-b border-neutral-200 px-4 py-1.5">
              <button
                type="button"
                onClick={toggleAll}
                aria-label={allChecked ? 'Deselect all' : 'Select all'}
                className={`flex h-5 w-5 items-center justify-center rounded border ${
                  allChecked
                    ? 'border-gmail-600 bg-gmail-600 text-white'
                    : 'border-neutral-300 bg-white text-transparent hover:border-neutral-400'
                }`}
              >
                <CheckIcon size={13} />
              </button>
              {checked.size > 0 ? (
                <BulkBar
                  ids={Array.from(checked)}
                  onDone={() => {
                    setChecked(new Set())
                    invalidateList()
                  }}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => invalidateList()}
                  aria-label="Refresh"
                  className="ml-1 rounded-full p-1.5 text-neutral-500 hover:bg-neutral-100"
                >
                  <RepeatIcon size={16} />
                </button>
              )}
              <span className="ml-auto text-xs text-neutral-500">
                {items.length > 0 ? `${items.length} conversation${items.length === 1 ? '' : 's'}` : null}
              </span>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto">
              {listLoading ? (
                <ListSkeleton />
              ) : items.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-8 py-20 text-center">
                  <InboxIcon size={40} className="text-neutral-200" />
                  <p className="mt-3 text-sm text-neutral-500">
                    {query
                      ? `No mail matches “${query}”.`
                      : label
                        ? `No mail with the “${label}” label.`
                        : folder === 'spam'
                          ? 'No spam.'
                          : 'No email here yet.'}
                  </p>
                </div>
              ) : (
                <ul>
                  {items.map((m) => (
                    <ThreadRow
                      key={m.id}
                      item={m}
                      checked={checked.has(m.id)}
                      now={new Date()}
                      onOpen={() => setSelectedId(m.id)}
                      onToggle={() =>
                        setChecked((cur) => {
                          const next = new Set(cur)
                          if (next.has(m.id)) next.delete(m.id)
                          else next.add(m.id)
                          return next
                        })
                      }
                      onChanged={invalidateList}
                    />
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </div>

      {composing || resumeDraft ? (
        <ComposeDock
          accounts={accounts}
          initial={resumeDraft ?? undefined}
          onClose={() => {
            setComposing(false)
            setResumeDraft(null)
          }}
          onSentOrDeleted={() => {
            if (showDrafts) void utils.mail.drafts.list.invalidate()
          }}
        />
      ) : null}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Thread list row — Gmail single line: checkbox · star · sender · subject —
// snippet · date (replaced by row actions on hover).
// -----------------------------------------------------------------------------

type ThreadItem = {
  id: string
  contactId: string | null
  subject: string | null
  unreadCount: number
  status: string
  isStarred: boolean
  isTrashed: boolean
  preview: string | null
  labels: string[]
  lastMessageAt: Date
  accountAddress: string | null
  contactName: string | null
}

function ThreadRow({
  item,
  checked,
  now,
  onOpen,
  onToggle,
  onChanged,
}: {
  item: ThreadItem
  checked: boolean
  now: Date
  onOpen: () => void
  onToggle: () => void
  onChanged: () => void
}) {
  const setStarred = trpc.mail.thread.setStarred.useMutation()
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()
  const unread = item.unreadCount > 0
  const who = item.contactName ?? (item.contactId ? 'Contact' : 'Unmatched sender')

  const act = (p: Promise<unknown>, label: string) => {
    p.then(() => {
      toast.success(label)
      onChanged()
    }).catch((e) => toast.error(e instanceof Error ? e.message : 'Action failed'))
  }

  return (
    <li
      onClick={onOpen}
      className={`group flex h-11 cursor-pointer items-center gap-3 border-b border-neutral-100 px-4 transition-shadow ${
        checked ? 'bg-gmail-50' : unread ? 'bg-white' : 'bg-neutral-50/40'
      } hover:relative hover:z-10 hover:bg-white hover:shadow-md`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        aria-label={checked ? 'Deselect' : 'Select'}
        className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border ${
          checked
            ? 'border-gmail-600 bg-gmail-600 text-white'
            : 'border-neutral-300 bg-white text-transparent hover:border-neutral-500'
        }`}
      >
        <CheckIcon size={12} />
      </button>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          act(setStarred.mutateAsync({ conversationId: item.id, starred: !item.isStarred }), item.isStarred ? 'Unstarred' : 'Starred')
        }}
        aria-label={item.isStarred ? 'Unstar' : 'Star'}
        className="shrink-0"
      >
        <StarIcon
          size={17}
          className={item.isStarred ? 'fill-secondary-400 text-secondary-400' : 'text-neutral-300 hover:text-neutral-500'}
        />
      </button>

      <Avatar name={who} size={24} />

      <span
        className={`w-40 shrink-0 truncate text-sm ${
          unread ? 'font-semibold text-neutral-900' : 'text-neutral-600'
        }`}
      >
        {who}
      </span>

      <span className="min-w-0 flex-1 truncate text-sm">
        {item.labels.map((l) => (
          <span
            key={l}
            className="mr-1 inline-block max-w-[10rem] truncate rounded border border-neutral-200 bg-neutral-100 px-1.5 py-px align-middle text-[10px] font-medium text-neutral-600"
          >
            {l}
          </span>
        ))}
        <span className={unread ? 'font-semibold text-neutral-900' : 'text-neutral-700'}>
          {item.subject ?? '(no subject)'}
        </span>
        {item.preview ? <span className="text-neutral-500"> — {item.preview}</span> : null}
      </span>

      {item.isTrashed ? (
        <span className="shrink-0 rounded bg-danger-50 px-1.5 text-[11px] text-danger-600">Trash</span>
      ) : item.status === 'archived' ? (
        <span className="shrink-0 rounded bg-neutral-100 px-1.5 text-[11px] text-neutral-500">Archived</span>
      ) : null}

      {/* Date (default) → row actions (hover) */}
      <time
        className="w-16 shrink-0 text-right text-xs tabular-nums text-neutral-500 group-hover:hidden"
        dateTime={item.lastMessageAt.toISOString()}
      >
        {gmailDate(item.lastMessageAt, now)}
      </time>
      <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <RowAction
          label="Archive"
          onClick={() => act(setArchived.mutateAsync({ conversationId: item.id, archived: true }), 'Archived')}
        >
          <ArchiveIcon size={16} />
        </RowAction>
        <RowAction
          label="Trash"
          onClick={() => act(setTrashed.mutateAsync({ conversationId: item.id, trashed: true }), 'Moved to Trash')}
        >
          <Trash2Icon size={16} />
        </RowAction>
        <RowAction
          label={unread ? 'Mark read' : 'Mark unread'}
          onClick={() => act(setRead.mutateAsync({ conversationId: item.id, read: unread }), unread ? 'Marked read' : 'Marked unread')}
        >
          <MailIcon size={16} />
        </RowAction>
      </div>
    </li>
  )
}

function RowAction({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded-full p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
    >
      {children}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Labels menu — Gmail's "Labels" button on the open thread. Lists the account's
// custom Gmail labels (mail.thread.labels) as a checklist; toggling applies the
// change to the live mailbox (mail.thread.setLabels) and converges the head, so
// labelling in the CRM and in Gmail stay identical.
// -----------------------------------------------------------------------------

function LabelMenu({
  conversationId,
  currentNames,
  onChanged,
}: {
  conversationId: string
  currentNames: string[]
  onChanged: () => void | Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const labels = trpc.mail.thread.labels.useQuery({ conversationId }, { enabled: open })
  const setLabels = trpc.mail.thread.setLabels.useMutation()
  const current = new Set(currentNames)

  const toggle = (label: { id: string; name: string }) => {
    const has = current.has(label.name)
    setLabels
      .mutateAsync({
        conversationId,
        ...(has ? { remove: [label.id] } : { add: [label.id] }),
      })
      .then(async () => {
        toast.success(has ? `Removed “${label.name}”` : `Labelled “${label.name}”`)
        await onChanged()
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'Could not update labels'))
  }

  return (
    <div className="relative">
      <RowAction label="Labels" onClick={() => setOpen((v) => !v)}>
        <TagIcon size={17} />
      </RowAction>
      {open ? (
        <>
          <button
            type="button"
            aria-label="Close labels menu"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-9 z-20 max-h-80 w-60 overflow-y-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
            <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              Label as
            </p>
            {labels.isLoading ? (
              <p className="px-3 py-2 text-sm text-neutral-400">Loading…</p>
            ) : (labels.data?.length ?? 0) === 0 ? (
              <p className="px-3 py-2 text-sm text-neutral-400">
                No labels yet — create them in Gmail.
              </p>
            ) : (
              (labels.data ?? []).map((l) => {
                const has = current.has(l.name)
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => toggle(l)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                        has ? 'border-gmail-600 bg-gmail-600 text-white' : 'border-neutral-300'
                      }`}
                    >
                      {has ? <CheckIcon size={11} /> : null}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{l.name}</span>
                  </button>
                )
              })
            )}
          </div>
        </>
      ) : null}
    </div>
  )
}

function ListSkeleton() {
  return (
    <ul>
      {Array.from({ length: 10 }).map((_, i) => (
        <li key={i} className="flex h-11 items-center gap-3 border-b border-neutral-100 px-4">
          <div className="h-4 w-4 shrink-0 animate-pulse rounded bg-neutral-100" />
          <div className="h-6 w-6 shrink-0 animate-pulse rounded-full bg-neutral-100" />
          <div className="h-3 w-32 animate-pulse rounded bg-neutral-100" />
          <div className="h-3 flex-1 animate-pulse rounded bg-neutral-100" />
        </li>
      ))}
    </ul>
  )
}

// -----------------------------------------------------------------------------
// Bulk actions (shown inline in the toolbar when rows are selected)
// -----------------------------------------------------------------------------

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()
  const [busy, setBusy] = useState(false)

  async function run(label: string, fn: (id: string) => Promise<unknown>) {
    setBusy(true)
    try {
      await Promise.all(ids.map((id) => fn(id)))
      toast.success(`${label} ${ids.length} conversation${ids.length === 1 ? '' : 's'}`)
      onDone()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="ml-1 flex items-center gap-0.5">
      <span className="px-1 text-xs font-medium text-neutral-600">{ids.length} selected</span>
      <RowAction label="Mark read" onClick={() => !busy && run('Marked read', (id) => setRead.mutateAsync({ conversationId: id, read: true }))}>
        <MailIcon size={16} />
      </RowAction>
      <RowAction label="Archive" onClick={() => !busy && run('Archived', (id) => setArchived.mutateAsync({ conversationId: id, archived: true }))}>
        <ArchiveIcon size={16} />
      </RowAction>
      <RowAction label="Trash" onClick={() => !busy && run('Trashed', (id) => setTrashed.mutateAsync({ conversationId: id, trashed: true }))}>
        <Trash2Icon size={16} />
      </RowAction>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Conversation view — full width, Gmail style.
// -----------------------------------------------------------------------------

function ConversationView({
  conversationId,
  accounts,
  onBack,
  onChanged,
}: {
  conversationId: string
  accounts: AccountOption[]
  onBack: () => void
  onChanged: () => void
}) {
  const utils = trpc.useUtils()
  const convo = trpc.inbox.conversations.get.useQuery({ conversationId })
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setStarred = trpc.mail.thread.setStarred.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()
  const reply = trpc.mail.thread.reply.useMutation()
  const forward = trpc.mail.thread.forward.useMutation()
  const [body, setBody] = useState('')
  const [mode, setMode] = useState<null | 'reply' | 'replyAll' | 'forward'>(null)
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [bcc, setBcc] = useState('')
  const [showCcBcc, setShowCcBcc] = useState(false)
  const markedRef = useRef<Set<string>>(new Set())

  const head = convo.data?.head
  const messages = useMemo(() => convo.data?.messages ?? [], [convo.data])
  const replyAccount = accounts.find((a) => a.id === head?.mailAccountId)
  const replySigPreview = signatureText(replyAccount)

  useEffect(() => {
    if (!head || head.unreadCount <= 0 || markedRef.current.has(head.id)) return
    markedRef.current.add(head.id)
    setRead
      .mutateAsync({ conversationId: head.id, read: true })
      .then(() => onChanged())
      .catch(() => {})
  }, [head?.id, head?.unreadCount, setRead, onChanged])

  async function act(label: string, p: Promise<unknown>, close = false) {
    try {
      await p
      toast.success(label)
      await utils.inbox.conversations.get.invalidate({ conversationId })
      onChanged()
      if (close) onBack()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not complete that')
    }
  }

  const sending = reply.isPending || forward.isPending

  function openComposer(next: 'reply' | 'replyAll' | 'forward') {
    setMode(next)
    setShowCcBcc(false)
    setTimeout(() => document.getElementById('mail-reply')?.focus(), 0)
  }
  function closeComposer() {
    setMode(null)
    setBody('')
    setTo('')
    setCc('')
    setBcc('')
    setShowCcBcc(false)
  }
  const parseList = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)

  async function sendComposer() {
    try {
      const ccList = parseList(cc)
      const bccList = parseList(bcc)
      if (mode === 'forward') {
        const toList = parseList(to)
        if (toList.length === 0) {
          toast.error('Add at least one recipient to forward to')
          return
        }
        await forward.mutateAsync({
          conversationId,
          to: toList,
          ...(ccList.length > 0 ? { cc: ccList } : {}),
          ...(bccList.length > 0 ? { bcc: bccList } : {}),
          body: body.trim(),
        })
        toast.success('Forwarded')
      } else {
        const trimmed = body.trim()
        if (!trimmed) return
        await reply.mutateAsync({
          conversationId,
          body: trimmed,
          replyAll: mode === 'replyAll',
          ...(ccList.length > 0 ? { cc: ccList } : {}),
          ...(bccList.length > 0 ? { bcc: bccList } : {}),
        })
        toast.success(mode === 'replyAll' ? 'Reply-all sent' : 'Reply sent')
      }
      closeComposer()
      await utils.inbox.conversations.get.invalidate({ conversationId })
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send')
    }
  }

  if (convo.isLoading) {
    return <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">Loading…</div>
  }
  if (!head) {
    return <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">Conversation not found.</div>
  }
  const now = new Date()
  const isEmail = head.provider === 'email'
  const starred = head.isStarred ?? false

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-neutral-200 px-3 py-1.5">
        <RowAction label="Back" onClick={onBack}>
          <ChevronLeftIcon size={18} />
        </RowAction>
        {isEmail ? (
          <>
            <RowAction label="Archive" onClick={() => act('Archived', setArchived.mutateAsync({ conversationId, archived: true }), true)}>
              <ArchiveIcon size={17} />
            </RowAction>
            <RowAction label="Trash" onClick={() => act('Moved to Trash', setTrashed.mutateAsync({ conversationId, trashed: true }), true)}>
              <Trash2Icon size={17} />
            </RowAction>
            <RowAction label="Mark unread" onClick={() => act('Marked unread', setRead.mutateAsync({ conversationId, read: false }), true)}>
              <MailIcon size={17} />
            </RowAction>
            <LabelMenu
              conversationId={conversationId}
              currentNames={head.tags}
              onChanged={async () => {
                await utils.inbox.conversations.get.invalidate({ conversationId })
                onChanged()
              }}
            />
          </>
        ) : null}
      </div>

      {/* Subject */}
      <div className="flex items-start gap-2 border-b border-neutral-100 px-6 py-4">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-normal text-neutral-900">
            {head.subject ?? '(no subject)'}
          </h1>
          {head.tags.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {head.tags.map((l) => (
                <span
                  key={l}
                  className="rounded border border-neutral-200 bg-neutral-100 px-1.5 py-px text-[11px] font-medium text-neutral-600"
                >
                  {l}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        {isEmail ? (
          <button
            type="button"
            onClick={() => act(starred ? 'Unstarred' : 'Starred', setStarred.mutateAsync({ conversationId, starred: !starred }))}
            aria-label={starred ? 'Unstar' : 'Star'}
            className="mt-1 shrink-0"
          >
            <StarIcon size={18} className={starred ? 'fill-secondary-400 text-secondary-400' : 'text-neutral-300 hover:text-neutral-500'} />
          </button>
        ) : null}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-neutral-400">No messages in this thread yet.</p>
        ) : (
          <div className="space-y-5">
            {messages.map((m) => {
              const outbound = m.direction === 'outbound'
              const sender = outbound ? (m.senderName ?? 'You') : (m.senderName ?? head.contactName ?? 'Contact')
              return (
                <article key={m.id} className="flex gap-3">
                  <Avatar name={sender} size={36} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-sm font-semibold text-neutral-900">{sender}</span>
                      <time className="shrink-0 text-xs text-neutral-400" dateTime={m.occurredAt.toISOString()}>
                        {gmailDate(m.occurredAt, now)}
                      </time>
                    </div>
                    <div className="mt-2">
                      {m.bodyHtml || m.gmailMessageId ? (
                        <EmailHtmlBody interactionId={m.id} text={displayMessageBody(m.body) ?? ''} />
                      ) : (
                        <p className="whitespace-pre-wrap break-words text-sm text-neutral-800">
                          {displayMessageBody(m.body) ?? '(no content)'}
                        </p>
                      )}
                    </div>
                    {m.mailAttachments.length > 0 ? (
                      <ul className="mt-3 flex flex-wrap gap-2">
                        {m.mailAttachments.map((a) => (
                          <li key={a.index}>
                            <a
                              href={`/api/internal/mail-attachments/${m.id}/${a.index}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-gmail-300 hover:bg-gmail-50"
                            >
                              <FileTextIcon size={14} />
                              <span className="max-w-[14rem] truncate">{a.filename}</span>
                              {a.sizeBytes ? (
                                <span className="text-neutral-400">{Math.max(1, Math.round(a.sizeBytes / 1024))} KB</span>
                              ) : null}
                            </a>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </div>

      {/* Reply / Reply all / Forward */}
      {isEmail ? (
        <div className="border-t border-neutral-200 bg-white px-6 py-3">
          {mode ? (
            <div className="rounded-xl border border-neutral-200 shadow-sm">
              <div className="flex items-center gap-2 border-b border-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-500">
                {mode === 'forward' ? (
                  <>
                    <ForwardIcon size={13} /> Forward
                  </>
                ) : mode === 'replyAll' ? (
                  <>
                    <ReplyIcon size={13} /> Reply all
                  </>
                ) : (
                  <>
                    <ReplyIcon size={13} /> Reply
                  </>
                )}
              </div>
              {mode === 'forward' ? (
                <input
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="To (comma-separated)"
                  aria-label="Forward to"
                  className="w-full border-b border-neutral-100 px-3 py-2 text-sm focus:outline-none"
                />
              ) : null}
              {showCcBcc ? (
                <>
                  <input
                    value={cc}
                    onChange={(e) => setCc(e.target.value)}
                    placeholder="Cc"
                    aria-label="Cc"
                    className="w-full border-b border-neutral-100 px-3 py-2 text-sm focus:outline-none"
                  />
                  <input
                    value={bcc}
                    onChange={(e) => setBcc(e.target.value)}
                    placeholder="Bcc"
                    aria-label="Bcc"
                    className="w-full border-b border-neutral-100 px-3 py-2 text-sm focus:outline-none"
                  />
                </>
              ) : null}
              <Textarea
                id="mail-reply"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={4}
                placeholder={mode === 'forward' ? 'Add a message (optional)…' : 'Reply…'}
                aria-label={mode === 'forward' ? 'Forward message' : 'Reply'}
                className="rounded-none border-0 focus:ring-0"
              />
              <div className="flex items-center justify-between gap-3 border-t border-neutral-100 px-3 py-2">
                <div className="flex items-center gap-3">
                  {!showCcBcc ? (
                    <button
                      type="button"
                      onClick={() => setShowCcBcc(true)}
                      className="text-[11px] font-medium text-neutral-500 hover:text-neutral-700"
                    >
                      Cc/Bcc
                    </button>
                  ) : null}
                  <span className="truncate text-[11px] text-neutral-400" title={replySigPreview}>
                    {replySigPreview ? `Signature: ${replySigPreview}` : ''}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={closeComposer}
                    className="rounded-md px-2 py-1 text-sm text-neutral-500 hover:bg-neutral-100"
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    disabled={sending || (mode === 'forward' ? !to.trim() : !body.trim())}
                    onClick={sendComposer}
                    className="inline-flex items-center gap-1.5 rounded-full bg-gmail-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-gmail-700 disabled:opacity-50"
                  >
                    <SendIcon size={15} /> {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => openComposer('reply')}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                <ReplyIcon size={15} /> Reply
              </button>
              <button
                type="button"
                onClick={() => openComposer('replyAll')}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                <ReplyIcon size={15} /> Reply all
              </button>
              <button
                type="button"
                onClick={() => openComposer('forward')}
                className="inline-flex items-center gap-2 rounded-full border border-neutral-300 px-4 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
              >
                <ForwardIcon size={15} /> Forward
              </button>
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Email HTML body — rendered like Gmail in a LOCKED sandboxed iframe. ADR 0041.
// `sandbox` WITHOUT allow-scripts (no JS) and WITHOUT allow-same-origin (unique
// origin: can't read our cookies/DOM). The HTML is served by a dedicated route
// (`/api/internal/mail-render/:id`) that carries its OWN relaxed CSP so remote
// images + inline styles render (a `srcdoc` iframe inherits the app's strict CSP
// and blocked both). Sanitised server-side as defence in depth.
// -----------------------------------------------------------------------------

function EmailHtmlBody({ interactionId, text }: { interactionId: string; text: string }) {
  const [showHtml, setShowHtml] = useState(true)
  return (
    <div>
      {showHtml ? (
        <iframe
          title="Email message"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          src={`/api/internal/mail-render/${interactionId}`}
          className="w-full bg-white"
          style={{ height: 460, border: 0 }}
        />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">{text || '(no content)'}</p>
      )}
      <button
        type="button"
        onClick={() => setShowHtml((v) => !v)}
        className="mt-1 text-[11px] font-medium text-neutral-400 hover:text-neutral-600"
      >
        {showHtml ? 'View plain text' : 'View formatted'}
      </button>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compose — docked bottom-right (Gmail "New Message" window). Auto-saves to a
// Gmail draft while typing; sends via drafts.send (no duplicate) when a draft
// exists, else a fresh compose.
// -----------------------------------------------------------------------------

export interface DraftInitial {
  draftId: string
  accountId: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
}

const splitAddrs = (s: string) => s.split(/[,;]/).map((x) => x.trim()).filter(Boolean)

function ComposeDock({
  accounts,
  initial,
  onClose,
  onSentOrDeleted,
}: {
  accounts: AccountOption[]
  initial?: DraftInitial | undefined
  onClose: () => void
  onSentOrDeleted?: () => void
}) {
  const utils = trpc.useUtils()
  const compose = trpc.mail.compose.useMutation()
  const draftSave = trpc.mail.drafts.save.useMutation()
  const draftSend = trpc.mail.drafts.send.useMutation()
  const draftDelete = trpc.mail.drafts.delete.useMutation()
  const [accountId, setAccountId] = useState(initial?.accountId ?? accounts[0]?.id ?? '')
  const [to, setTo] = useState(initial?.to ?? '')
  const [cc, setCc] = useState(initial?.cc ?? '')
  const [bcc, setBcc] = useState(initial?.bcc ?? '')
  const [showCc, setShowCc] = useState(Boolean(initial?.cc || initial?.bcc))
  const [subject, setSubject] = useState(initial?.subject ?? '')
  const [body, setBody] = useState(initial?.body ?? '')
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const draftIdRef = useRef<string | null>(initial?.draftId ?? null)
  const [hasDraft, setHasDraft] = useState(Boolean(initial?.draftId))
  const sigPreview = signatureText(accounts.find((a) => a.id === accountId))

  // Auto-save: debounce content changes into a Gmail draft (create then update).
  const skipFirst = useRef(true)
  useEffect(() => {
    if (skipFirst.current) {
      skipFirst.current = false
      return
    }
    if (!accountId) return
    const hasContent = [to, cc, bcc, subject, body].some((v) => v.trim().length > 0)
    if (!hasContent) return
    const t = setTimeout(async () => {
      try {
        setSaveStatus('saving')
        const res = await draftSave.mutateAsync({
          mailAccountId: accountId,
          ...(draftIdRef.current ? { draftId: draftIdRef.current } : {}),
          to: splitAddrs(to),
          cc: splitAddrs(cc),
          bcc: splitAddrs(bcc),
          subject,
          body,
        })
        draftIdRef.current = res.draftId
        setHasDraft(true)
        setSaveStatus('saved')
      } catch {
        setSaveStatus('error')
      }
    }, 1500)
    return () => clearTimeout(t)
    // draftId intentionally excluded (ref) to avoid a save loop.
  }, [accountId, to, cc, bcc, subject, body, draftSave])

  async function send() {
    const recipients = splitAddrs(to)
    if (recipients.length === 0 || !accountId) {
      toast.error('Add at least one recipient.')
      return
    }
    const ccList = splitAddrs(cc)
    const bccList = splitAddrs(bcc)
    try {
      if (draftIdRef.current) {
        // Flush the latest content into the draft, then send it (no duplicate).
        await draftSave.mutateAsync({
          mailAccountId: accountId,
          draftId: draftIdRef.current,
          to: recipients,
          cc: ccList,
          bcc: bccList,
          subject,
          body,
        })
        await draftSend.mutateAsync({
          mailAccountId: accountId,
          draftId: draftIdRef.current,
          to: recipients,
          ...(ccList.length > 0 ? { cc: ccList } : {}),
          ...(bccList.length > 0 ? { bcc: bccList } : {}),
          subject: subject.trim(),
        })
      } else {
        if (!subject.trim() || !body.trim()) {
          toast.error('Add a subject and message.')
          return
        }
        await compose.mutateAsync({
          mailAccountId: accountId,
          to: recipients,
          ...(ccList.length > 0 ? { cc: ccList } : {}),
          ...(bccList.length > 0 ? { bcc: bccList } : {}),
          subject: subject.trim(),
          body: body.trim(),
        })
      }
      toast.success('Email sent')
      void utils.mail.threads.list.invalidate()
      onSentOrDeleted?.()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the email')
    }
  }

  async function discardDraft() {
    if (!draftIdRef.current) {
      onClose()
      return
    }
    try {
      await draftDelete.mutateAsync({ mailAccountId: accountId, draftId: draftIdRef.current })
      toast.message('Draft discarded')
      onSentOrDeleted?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not discard the draft')
    } finally {
      onClose()
    }
  }

  const sending = compose.isPending || draftSend.isPending
  const statusLabel =
    saveStatus === 'saving' ? 'Saving…' : saveStatus === 'saved' ? 'Draft saved' : hasDraft ? 'Draft' : ''

  return (
    <div className="fixed bottom-0 right-6 z-50 flex w-[min(32rem,calc(100vw-2rem))] flex-col rounded-t-lg bg-white shadow-2xl ring-1 ring-neutral-200">
      <div className="flex items-center justify-between rounded-t-lg bg-neutral-800 px-4 py-2 text-sm font-medium text-white">
        <span className="flex items-center gap-2">
          {hasDraft ? 'Draft' : 'New message'}
          {statusLabel ? <span className="text-[11px] font-normal text-white/60">{statusLabel}</span> : null}
        </span>
        <span className="flex items-center gap-1">
          {hasDraft ? (
            <button
              type="button"
              onClick={discardDraft}
              aria-label="Discard draft"
              className="rounded p-0.5 hover:bg-white/10"
            >
              <Trash2Icon size={15} />
            </button>
          ) : null}
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-0.5 hover:bg-white/10">
            <XIcon size={16} />
          </button>
        </span>
      </div>
      <div className="flex flex-col">
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          aria-label="From"
          className="border-b border-neutral-100 px-4 py-2 text-sm text-neutral-700 focus:outline-none"
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName ? `${a.displayName} <${a.address}>` : a.address}
            </option>
          ))}
        </select>
        <div className="relative border-b border-neutral-100">
          <input
            value={to}
            onChange={(e) => setTo(e.target.value)}
            placeholder="To"
            aria-label="To"
            className="w-full px-4 py-2 text-sm placeholder:text-neutral-400 focus:outline-none"
          />
          {!showCc ? (
            <button
              type="button"
              onClick={() => setShowCc(true)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-neutral-400 hover:text-neutral-600"
            >
              Cc/Bcc
            </button>
          ) : null}
        </div>
        {showCc ? (
          <>
            <input
              value={cc}
              onChange={(e) => setCc(e.target.value)}
              placeholder="Cc"
              aria-label="Cc"
              className="border-b border-neutral-100 px-4 py-2 text-sm placeholder:text-neutral-400 focus:outline-none"
            />
            <input
              value={bcc}
              onChange={(e) => setBcc(e.target.value)}
              placeholder="Bcc"
              aria-label="Bcc"
              className="border-b border-neutral-100 px-4 py-2 text-sm placeholder:text-neutral-400 focus:outline-none"
            />
          </>
        ) : null}
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Subject"
          aria-label="Subject"
          className="border-b border-neutral-100 px-4 py-2 text-sm font-medium placeholder:text-neutral-400 focus:outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          placeholder="Write your message…"
          aria-label="Message"
          className="resize-none px-4 py-3 text-sm placeholder:text-neutral-400 focus:outline-none"
        />
        {sigPreview ? (
          <p className="truncate px-4 pb-1 text-[11px] text-neutral-400" title={sigPreview}>
            Signature appended: {sigPreview}
          </p>
        ) : null}
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          type="button"
          disabled={sending}
          onClick={send}
          className="inline-flex items-center gap-1.5 rounded-full bg-gmail-600 px-5 py-2 text-sm font-medium text-white hover:bg-gmail-700 disabled:opacity-50"
        >
          <SendIcon size={15} /> {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Drafts folder — Gmail-backed list with resume + delete.
// -----------------------------------------------------------------------------

function DraftsList({
  accountId,
  onResume,
}: {
  accountId: string | null
  onResume: (d: DraftInitial) => void
}) {
  const utils = trpc.useUtils()
  const del = trpc.mail.drafts.delete.useMutation()
  const list = trpc.mail.drafts.list.useQuery(
    { mailAccountId: accountId ?? '' },
    { enabled: !!accountId },
  )
  const now = new Date()

  if (!accountId) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-20 text-center">
        <FileTextIcon size={40} className="text-neutral-200" />
        <p className="mt-3 text-sm text-neutral-500">Connect a Gmail account to see drafts.</p>
      </div>
    )
  }
  if (list.isLoading) return <ListSkeleton />
  const items = list.data?.items ?? []
  if (items.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center px-8 py-20 text-center">
        <FileTextIcon size={40} className="text-neutral-200" />
        <p className="mt-3 text-sm text-neutral-500">No drafts.</p>
      </div>
    )
  }

  async function resume(draftId: string) {
    try {
      const d = await utils.mail.drafts.get.fetch({ mailAccountId: accountId!, draftId })
      onResume({
        draftId,
        accountId: accountId!,
        to: d.to.join(', '),
        cc: d.cc.join(', '),
        bcc: d.bcc.join(', '),
        subject: d.subject,
        body: d.body,
      })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not open the draft')
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <ul>
        {items.map((d) => (
          <li
            key={d.draftId}
            className="group flex cursor-pointer items-center gap-3 border-b border-neutral-100 px-4 py-2.5 hover:bg-neutral-50"
            onClick={() => void resume(d.draftId)}
          >
            <span className="w-44 shrink-0 truncate text-sm text-neutral-700">
              {d.to.length > 0 ? `To: ${d.to.join(', ')}` : 'No recipient'}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium text-red-600">Draft</span>{' '}
              <span className="text-neutral-900">{d.subject}</span>
              {d.snippet ? <span className="text-neutral-500"> — {d.snippet}</span> : null}
            </span>
            <span className="shrink-0 text-xs text-neutral-400 group-hover:hidden">
              {d.date ? gmailDate(new Date(d.date), now) : ''}
            </span>
            <button
              type="button"
              aria-label="Delete draft"
              onClick={(e) => {
                e.stopPropagation()
                del
                  .mutateAsync({ mailAccountId: accountId!, draftId: d.draftId })
                  .then(() => {
                    toast.message('Draft deleted')
                    void utils.mail.drafts.list.invalidate()
                  })
                  .catch((err) => toast.error(err instanceof Error ? err.message : 'Could not delete'))
              }}
              className="hidden shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 group-hover:block"
            >
              <Trash2Icon size={15} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Advanced search — builds a Gmail `q` string from fields (E4). The operators
// (from:/to:/subject:/has:attachment/is:unread/is:starred/after:/before:) are
// Gmail's own, so the resulting query runs natively through mail.search.
// -----------------------------------------------------------------------------

function AdvancedSearchPanel({
  onApply,
  onClose,
}: {
  onApply: (q: string) => void
  onClose: () => void
}) {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [words, setWords] = useState('')
  const [after, setAfter] = useState('')
  const [before, setBefore] = useState('')
  const [hasAttachment, setHasAttachment] = useState(false)
  const [isUnread, setIsUnread] = useState(false)
  const [isStarred, setIsStarred] = useState(false)

  function build(): string {
    const parts: string[] = []
    if (from.trim()) parts.push(`from:(${from.trim()})`)
    if (to.trim()) parts.push(`to:(${to.trim()})`)
    if (subject.trim()) parts.push(`subject:(${subject.trim()})`)
    if (hasAttachment) parts.push('has:attachment')
    if (isUnread) parts.push('is:unread')
    if (isStarred) parts.push('is:starred')
    // Gmail wants YYYY/MM/DD for after:/before:.
    if (after) parts.push(`after:${after.replace(/-/g, '/')}`)
    if (before) parts.push(`before:${before.replace(/-/g, '/')}`)
    if (words.trim()) parts.push(words.trim())
    return parts.join(' ')
  }

  const field = 'w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm focus:border-gmail-300 focus:outline-none focus:ring-1 focus:ring-gmail-100'

  return (
    <div className="absolute left-0 right-0 top-12 z-20 rounded-lg border border-neutral-200 bg-white p-4 text-sm shadow-lg">
      <div className="grid grid-cols-2 gap-3">
        <label className="col-span-1 flex flex-col gap-1 text-xs text-neutral-500">
          From
          <input value={from} onChange={(e) => setFrom(e.target.value)} className={field} />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-xs text-neutral-500">
          To
          <input value={to} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-500">
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} className={field} />
        </label>
        <label className="col-span-2 flex flex-col gap-1 text-xs text-neutral-500">
          Has the words
          <input value={words} onChange={(e) => setWords(e.target.value)} className={field} />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-xs text-neutral-500">
          After
          <input type="date" value={after} onChange={(e) => setAfter(e.target.value)} className={field} />
        </label>
        <label className="col-span-1 flex flex-col gap-1 text-xs text-neutral-500">
          Before
          <input type="date" value={before} onChange={(e) => setBefore(e.target.value)} className={field} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-4 text-sm text-neutral-700">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={hasAttachment} onChange={(e) => setHasAttachment(e.target.checked)} />
          Has attachment
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={isUnread} onChange={(e) => setIsUnread(e.target.checked)} />
          Unread
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={isStarred} onChange={(e) => setIsStarred(e.target.checked)} />
          Starred
        </label>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-md px-3 py-1.5 text-sm text-neutral-500 hover:bg-neutral-100"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            const q = build()
            if (q) onApply(q)
          }}
          className="rounded-full bg-gmail-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-gmail-700"
        >
          Search
        </button>
      </div>
    </div>
  )
}
