'use client'

// The /mail email client (ADR 0021 Phase 4 polish). A three-pane workspace —
// account/folder rail · thread list (search + multi-select + bulk actions) ·
// reading pane (inline thread, actions, reply) — that reads like a real mail
// client while staying fully synced with Gmail. All actions go through the
// audited tRPC mutations; the live mailbox is the source of truth.
// CLAUDE.md §4 (tokens, density), §14, §26.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  ArchiveIcon,
  CheckIcon,
  FileTextIcon,
  MailIcon,
  PlusIcon,
  SearchIcon,
  SendIcon,
  StarIcon,
  Trash2Icon,
  XIcon,
} from '@/components/ui/icon'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { useConversationStream } from '@/lib/hooks/use-conversation-stream'
import { trpc } from '@/lib/trpc/client'

interface AccountOption {
  id: string
  address: string
  displayName: string | null
}

type Folder = 'all' | 'unread'

export function MailWorkspace({
  accounts,
}: {
  accounts: AccountOption[]
}) {
  const utils = trpc.useUtils()
  useConversationStream() // live updates: new mail / actions refresh the list
  const [accountId, setAccountId] = useState<string | null>(null)
  const [folder, setFolder] = useState<Folder>('all')
  const [rawQuery, setRawQuery] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())

  // Debounce the search box so typing is smooth.
  useEffect(() => {
    const t = setTimeout(() => setQuery(rawQuery.trim()), 250)
    return () => clearTimeout(t)
  }, [rawQuery])

  const threads = trpc.mail.threads.list.useQuery({
    mailAccountId: accountId,
    filter: folder,
    q: query || null,
    limit: 50,
  })

  const [composing, setComposing] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const kbArchive = trpc.mail.thread.setArchived.useMutation()
  const kbRead = trpc.mail.thread.setRead.useMutation()
  const kbStar = trpc.mail.thread.setStarred.useMutation()
  const kbTrash = trpc.mail.thread.setTrashed.useMutation()

  const items = useMemo(() => threads.data?.items ?? [], [threads.data])

  const invalidateList = useCallback(() => {
    void utils.mail.threads.list.invalidate()
  }, [utils])

  const refreshOpen = useCallback(() => {
    invalidateList()
    if (selectedId) {
      void utils.inbox.conversations.get.invalidate({ conversationId: selectedId })
    }
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

  // Keyboard shortcuts (Superhuman-style). Inert while typing in a field.
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
        case '?':
          setShowHelp((s) => !s)
          break
        case 'Escape':
          if (composing) setComposing(false)
          else if (showHelp) setShowHelp(false)
          else setSelectedId(null)
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [items, selectedId, composing, showHelp, kbdAction, kbArchive, kbRead, kbStar, kbTrash])

  return (
    <Card className="flex h-[calc(100vh-9.5rem)] overflow-hidden">
      <Rail
        accounts={accounts}
        accountId={accountId}
        folder={folder}
        onCompose={() => setComposing(true)}
        onAccount={(id) => {
          setAccountId(id)
          setSelectedId(null)
          setChecked(new Set())
        }}
        onFolder={(f) => {
          setFolder(f)
          setChecked(new Set())
        }}
      />

      {/* Thread list — full-width on mobile (master-detail with the reading
          pane); fixed-width column on lg+. */}
      <div
        className={`${selectedId ? 'hidden lg:flex' : 'flex'} w-full shrink-0 flex-col border-r border-neutral-200 lg:w-[22rem]`}
      >
        <div className="border-b border-neutral-200 p-2">
          <div className="relative">
            <SearchIcon
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-400"
            />
            <Input
              id="mail-search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search mail…   ( / )"
              aria-label="Search mail"
              className="h-9 pl-8"
            />
          </div>
        </div>

        {checked.size > 0 ? (
          <BulkBar
            ids={Array.from(checked)}
            onDone={() => {
              setChecked(new Set())
              invalidateList()
            }}
            onClear={() => setChecked(new Set())}
          />
        ) : null}

        <div className="flex-1 overflow-y-auto">
          {threads.isLoading ? (
            <ListSkeleton />
          ) : items.length === 0 ? (
            <div className="p-8 text-center text-sm text-neutral-500">
              {query
                ? `No mail matches “${query}”.`
                : folder === 'unread'
                  ? 'No unread email.'
                  : 'No email here yet.'}
            </div>
          ) : (
            <ul className="divide-y divide-neutral-100">
              {items.map((m) => (
                <ThreadRow
                  key={m.id}
                  item={m}
                  active={selectedId === m.id}
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
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      {/* Reading pane — hidden on mobile until a thread is opened. */}
      <div
        className={`${selectedId ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col overflow-hidden bg-neutral-50/40`}
      >
        {selectedId ? (
          <ReadingPane
            conversationId={selectedId}
            onClose={() => setSelectedId(null)}
            onChanged={invalidateList}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center text-center text-neutral-400">
            <MailIcon size={40} className="text-neutral-200" />
            <p className="mt-3 text-sm">Select a conversation to read it.</p>
            <p className="mt-1 text-xs text-neutral-300">
              Press <Kbd>?</Kbd> for keyboard shortcuts
            </p>
          </div>
        )}
      </div>

      {composing ? (
        <ComposeModal accounts={accounts} onClose={() => setComposing(false)} />
      ) : null}
      {showHelp ? <ShortcutsHelp onClose={() => setShowHelp(false)} /> : null}
    </Card>
  )
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded border border-neutral-300 bg-neutral-50 px-1 py-0.5 font-mono text-[10px] text-neutral-600">
      {children}
    </kbd>
  )
}

function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    ['j / k', 'Next / previous conversation'],
    ['e', 'Archive'],
    ['s', 'Star'],
    ['u', 'Mark unread'],
    ['#', 'Move to Trash'],
    ['r', 'Reply'],
    ['c', 'Compose'],
    ['/', 'Search'],
    ['Esc', 'Close'],
    ['?', 'Toggle this help'],
  ]
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-xl bg-white p-5 shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-sm font-semibold text-neutral-900">Keyboard shortcuts</h2>
        <dl className="space-y-1.5">
          {rows.map(([key, desc]) => (
            <div key={key} className="flex items-center justify-between gap-4 text-sm">
              <dt className="text-neutral-600">{desc}</dt>
              <dd>
                <Kbd>{key}</Kbd>
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Rail
// -----------------------------------------------------------------------------

function Rail({
  accounts,
  accountId,
  folder,
  onCompose,
  onAccount,
  onFolder,
}: {
  accounts: AccountOption[]
  accountId: string | null
  folder: Folder
  onCompose: () => void
  onAccount: (id: string | null) => void
  onFolder: (f: Folder) => void
}) {
  return (
    <aside className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-200 bg-neutral-50/60 p-3">
      <Button type="button" size="sm" className="w-full" onClick={onCompose}>
        <PlusIcon size={15} /> Compose
      </Button>

      <nav aria-label="Folders" className="flex flex-col gap-0.5">
        <RailItem label="All mail" active={folder === 'all'} onClick={() => onFolder('all')} />
        <RailItem label="Unread" active={folder === 'unread'} onClick={() => onFolder('unread')} />
      </nav>

      <div>
        <h2 className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
          Accounts
        </h2>
        <nav aria-label="Accounts" className="flex flex-col gap-0.5">
          <RailItem
            label="All accounts"
            active={accountId === null}
            onClick={() => onAccount(null)}
          />
          {accounts.map((a) => (
            <RailItem
              key={a.id}
              label={a.displayName ?? a.address}
              title={a.address}
              active={accountId === a.id}
              onClick={() => onAccount(a.id)}
            />
          ))}
          {accounts.length === 0 ? (
            <a
              href="/settings/email-accounts"
              className="rounded-md px-2.5 py-1.5 text-xs text-primary-700 hover:bg-neutral-100"
            >
              Connect an account…
            </a>
          ) : null}
        </nav>
      </div>
    </aside>
  )
}

function RailItem({
  label,
  title,
  active,
  onClick,
}: {
  label: string
  title?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-current={active ? 'true' : undefined}
      className={
        active
          ? 'truncate rounded-md bg-primary-100 px-2.5 py-1.5 text-left text-sm font-medium text-primary-800'
          : 'truncate rounded-md px-2.5 py-1.5 text-left text-sm text-neutral-700 transition-colors hover:bg-neutral-100'
      }
    >
      {label}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Thread list row
// -----------------------------------------------------------------------------

type ThreadItem = {
  id: string
  contactId: string | null
  subject: string | null
  unreadCount: number
  status: string
  lastMessageAt: Date
  accountAddress: string | null
  contactName: string | null
}

function ThreadRow({
  item,
  active,
  checked,
  now,
  onOpen,
  onToggle,
}: {
  item: ThreadItem
  active: boolean
  checked: boolean
  now: Date
  onOpen: () => void
  onToggle: () => void
}) {
  const unread = item.unreadCount > 0
  const who = item.contactName ?? (item.contactId ? 'Contact' : 'Unmatched sender')
  return (
    <li
      className={`group relative flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors ${
        active ? 'bg-primary-50' : checked ? 'bg-primary-50/40' : 'hover:bg-neutral-50'
      }`}
      onClick={onOpen}
    >
      {unread ? (
        <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-primary-500" />
      ) : null}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        aria-label={checked ? 'Deselect' : 'Select'}
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
          checked
            ? 'border-primary-600 bg-primary-600 text-white'
            : 'border-neutral-300 bg-white text-transparent group-hover:border-neutral-400'
        }`}
      >
        <CheckIcon size={11} />
      </button>
      <Avatar name={who} size={30} />
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
        <div
          className={`truncate text-[13px] ${
            unread ? 'font-medium text-neutral-800' : 'text-neutral-600'
          }`}
        >
          {item.subject ?? '(no subject)'}
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-neutral-400">
          {item.accountAddress ? <span className="truncate">{item.accountAddress}</span> : null}
          {item.status === 'archived' ? (
            <span className="rounded bg-neutral-100 px-1 text-neutral-500">Archived</span>
          ) : null}
          {item.unreadCount > 1 ? (
            <span className="rounded-full bg-primary-100 px-1.5 font-medium text-primary-700">
              {item.unreadCount}
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
      {Array.from({ length: 6 }).map((_, i) => (
        <li key={i} className="flex items-start gap-2.5 px-3 py-3">
          <div className="h-7 w-7 shrink-0 animate-pulse rounded-full bg-neutral-100" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
            <div className="h-3 w-3/4 animate-pulse rounded bg-neutral-100" />
          </div>
        </li>
      ))}
    </ul>
  )
}

// -----------------------------------------------------------------------------
// Bulk action bar
// -----------------------------------------------------------------------------

function BulkBar({
  ids,
  onDone,
  onClear,
}: {
  ids: string[]
  onDone: () => void
  onClear: () => void
}) {
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()
  const [busy, setBusy] = useState(false)

  async function run(
    label: string,
    fn: (conversationId: string) => Promise<unknown>,
  ) {
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
    <div className="flex items-center gap-1 border-b border-neutral-200 bg-primary-50/60 px-2 py-1.5">
      <span className="px-1 text-xs font-medium text-primary-800">{ids.length} selected</span>
      <div className="ml-auto flex items-center gap-0.5">
        <IconBtn
          label="Mark read"
          disabled={busy}
          onClick={() => run('Marked read', (id) => setRead.mutateAsync({ conversationId: id, read: true }))}
        >
          <CheckIcon size={15} />
        </IconBtn>
        <IconBtn
          label="Archive"
          disabled={busy}
          onClick={() =>
            run('Archived', (id) => setArchived.mutateAsync({ conversationId: id, archived: true }))
          }
        >
          <ArchiveIcon size={15} />
        </IconBtn>
        <IconBtn
          label="Trash"
          disabled={busy}
          onClick={() =>
            run('Trashed', (id) => setTrashed.mutateAsync({ conversationId: id, trashed: true }))
          }
        >
          <Trash2Icon size={15} />
        </IconBtn>
        <button
          type="button"
          onClick={onClear}
          className="ml-1 rounded p-1 text-neutral-500 hover:bg-white"
          aria-label="Clear selection"
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  )
}

function IconBtn({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="rounded-md p-1.5 text-neutral-600 transition-colors hover:bg-white hover:text-neutral-900 disabled:opacity-50"
    >
      {children}
    </button>
  )
}

// -----------------------------------------------------------------------------
// Reading pane
// -----------------------------------------------------------------------------

function ReadingPane({
  conversationId,
  onClose,
  onChanged,
}: {
  conversationId: string
  onClose: () => void
  onChanged: () => void
}) {
  const utils = trpc.useUtils()
  const convo = trpc.inbox.conversations.get.useQuery({ conversationId })
  const setRead = trpc.mail.thread.setRead.useMutation()
  const setArchived = trpc.mail.thread.setArchived.useMutation()
  const setStarred = trpc.mail.thread.setStarred.useMutation()
  const setTrashed = trpc.mail.thread.setTrashed.useMutation()
  const reply = trpc.mail.thread.reply.useMutation()
  const [body, setBody] = useState('')
  const [confirmTrash, setConfirmTrash] = useState(false)
  const markedRef = useRef<Set<string>>(new Set())

  const head = convo.data?.head
  const messages = useMemo(() => convo.data?.messages ?? [], [convo.data])

  // Mark read on open (like Gmail). Once per conversation per mount.
  useEffect(() => {
    if (!head || head.unreadCount <= 0 || markedRef.current.has(head.id)) return
    markedRef.current.add(head.id)
    setRead
      .mutateAsync({ conversationId: head.id, read: true })
      .then(() => onChanged())
      .catch(() => {})
  }, [head?.id, head?.unreadCount, setRead, onChanged])

  async function act(label: string, p: Promise<unknown>) {
    try {
      await p
      toast.success(label)
      await utils.inbox.conversations.get.invalidate({ conversationId })
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not complete that')
    }
  }

  async function sendReply() {
    const trimmed = body.trim()
    if (!trimmed) return
    try {
      await reply.mutateAsync({ conversationId, body: trimmed })
      setBody('')
      toast.success('Reply sent')
      await utils.inbox.conversations.get.invalidate({ conversationId })
      onChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the reply')
    }
  }

  if (convo.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
        Loading…
      </div>
    )
  }
  if (!head) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-neutral-400">
        Conversation not found.
      </div>
    )
  }

  const now = new Date()
  const isEmail = head.provider === 'email'

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header + actions */}
      <header className="flex items-start gap-2 border-b border-neutral-200 bg-white px-4 py-3">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="mt-0.5 rounded-md p-1 text-neutral-400 hover:bg-neutral-100 lg:hidden"
        >
          <XIcon size={16} />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-neutral-900">
            {head.subject ?? '(no subject)'}
          </h1>
          <p className="truncate text-xs text-neutral-500">
            {head.contactName ?? 'Unmatched sender'}
          </p>
        </div>
        {isEmail ? (
          <div className="flex shrink-0 items-center gap-0.5">
            <IconBtn
              label="Mark unread"
              onClick={() =>
                act('Marked unread', setRead.mutateAsync({ conversationId, read: false }))
              }
            >
              <MailIcon size={15} />
            </IconBtn>
            <IconBtn label="Star" onClick={() => act('Starred', setStarred.mutateAsync({ conversationId, starred: true }))}>
              <StarIcon size={15} />
            </IconBtn>
            <IconBtn
              label="Archive"
              onClick={() =>
                act('Archived', setArchived.mutateAsync({ conversationId, archived: true }))
              }
            >
              <ArchiveIcon size={15} />
            </IconBtn>
            {confirmTrash ? (
              <span className="flex items-center gap-1 rounded-md bg-danger-50 px-1.5 py-0.5">
                <span className="text-[11px] text-danger-700">Trash?</span>
                <button
                  type="button"
                  onClick={() =>
                    act('Moved to Trash', setTrashed.mutateAsync({ conversationId, trashed: true }))
                  }
                  className="text-[11px] font-semibold text-danger-700 hover:underline"
                >
                  Yes
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmTrash(false)}
                  className="text-[11px] text-neutral-500 hover:underline"
                >
                  No
                </button>
              </span>
            ) : (
              <IconBtn label="Trash" onClick={() => setConfirmTrash(true)}>
                <Trash2Icon size={15} />
              </IconBtn>
            )}
          </div>
        ) : null}
      </header>

      {/* Messages */}
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-neutral-400">No messages in this thread yet.</p>
        ) : (
          messages.map((m) => {
            const outbound = m.direction === 'outbound'
            return (
              <article
                key={m.id}
                className={`max-w-[42rem] rounded-xl border p-3 shadow-sm ${
                  outbound
                    ? 'ml-auto border-primary-100 bg-primary-50'
                    : 'mr-auto border-neutral-200 bg-white'
                }`}
              >
                <div className="mb-1 flex items-center justify-between gap-3 text-[11px] uppercase tracking-wide text-neutral-400">
                  <span>{outbound ? 'You' : (head.contactName ?? 'Contact')}</span>
                  <time dateTime={m.occurredAt.toISOString()}>
                    {formatRelativeTime(m.occurredAt, now)}
                  </time>
                </div>
                <p className="whitespace-pre-wrap break-words text-sm text-neutral-900">
                  {m.body ?? '(no content)'}
                </p>
                {m.mailAttachments.length > 0 ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5">
                    {m.mailAttachments.map((a) => (
                      <li key={a.index}>
                        <a
                          href={`/api/internal/mail-attachments/${m.id}/${a.index}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 hover:border-primary-300 hover:text-primary-700"
                        >
                          <FileTextIcon size={13} />
                          <span className="max-w-[14rem] truncate">{a.filename}</span>
                          {a.sizeBytes ? (
                            <span className="text-neutral-400">
                              {Math.max(1, Math.round(a.sizeBytes / 1024))} KB
                            </span>
                          ) : null}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            )
          })
        )}
      </div>

      {/* Reply */}
      {isEmail ? (
        <div className="border-t border-neutral-200 bg-white p-3">
          <Textarea
            id="mail-reply"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            placeholder="Reply… (sends from this mailbox and syncs to Gmail)   ( r )"
            aria-label="Reply"
          />
          <div className="mt-2 flex justify-end">
            <Button type="button" size="sm" disabled={reply.isPending || !body.trim()} onClick={sendReply}>
              <SendIcon size={15} /> {reply.isPending ? 'Sending…' : 'Send reply'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

// -----------------------------------------------------------------------------
// Compose modal
// -----------------------------------------------------------------------------

function ComposeModal({
  accounts,
  onClose,
}: {
  accounts: AccountOption[]
  onClose: () => void
}) {
  const utils = trpc.useUtils()
  const compose = trpc.mail.compose.useMutation()
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')

  async function send() {
    const recipients = to
      .split(/[,;]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (recipients.length === 0 || !subject.trim() || !body.trim() || !accountId) {
      toast.error('Add a recipient, subject and message.')
      return
    }
    try {
      await compose.mutateAsync({
        mailAccountId: accountId,
        to: recipients,
        subject: subject.trim(),
        body: body.trim(),
      })
      toast.success('Email sent')
      void utils.mail.threads.list.invalidate()
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not send the email')
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="New email"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl overflow-hidden rounded-xl bg-white shadow-card-hover"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-neutral-200 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-neutral-900">New email</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1 text-neutral-400 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="space-y-2 p-4">
          <select
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            aria-label="From"
            className="w-full rounded-md border border-neutral-200 px-2.5 py-1.5 text-sm focus:border-primary-400 focus:outline-none focus:ring-1 focus:ring-primary-200"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.displayName ? `${a.displayName} <${a.address}>` : a.address}
              </option>
            ))}
          </select>
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="To: name@example.com, …" aria-label="To" />
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" />
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={8}
            placeholder="Write your message…"
            aria-label="Message"
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-neutral-200 px-4 py-2.5">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={compose.isPending} onClick={send}>
            <SendIcon size={15} /> {compose.isPending ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}
