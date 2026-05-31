// Selectable conversation list + bulk triage toolbar (ADR 0020 Phase 6i).
// Renders the rows client-side so agents can multi-select and bulk
// mark-read / close / snooze / unsnooze via inbox.conversations.bulk.

'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import {
  MailIcon,
  MessageSquareIcon,
  PhoneIcon,
  SmartphoneIcon,
} from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

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

export interface ConversationListItem {
  id: string
  contactId: string | null
  channel: string | null
  status: 'open' | 'closed' | 'snoozed' | 'archived'
  unreadCount: number
  contactName: string | null
  assigneeName: string | null
  tags: string[]
  subject: string | null
  lastMessageAt: Date
  replyDeadlineAt: Date | null
}

const SNOOZE_OPTIONS = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: 'Tomorrow', minutes: 60 * 24 },
  { label: 'Next week', minutes: 60 * 24 * 7 },
] as const

export function BulkConversationList({ items }: { items: ConversationListItem[] }) {
  const router = useRouter()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const now = useMemo(() => new Date(), [])

  const bulk = trpc.inbox.conversations.bulk.useMutation({
    onSuccess: (r) => {
      const extra = 'skipped' in r && r.skipped ? `, ${r.skipped} skipped` : ''
      toast.success(
        `${r.succeeded} updated${r.failed ? `, ${r.failed} failed` : ''}${extra}`,
      )
      setSelected(new Set())
      router.refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Bulk action failed'),
  })

  const ids = useMemo(() => Array.from(selected), [selected])
  const allSelected = items.length > 0 && selected.size === items.length

  const toggle = (id: string) =>
    setSelected((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(items.map((i) => i.id)))

  const run = (action: 'markRead' | 'close' | 'unsnooze', minutes?: number) => {
    if (ids.length === 0) return
    bulk.mutate({ conversationIds: ids, action, minutes })
  }
  const runSnooze = (minutes: number) => {
    if (ids.length === 0) return
    bulk.mutate({ conversationIds: ids, action: 'snooze', minutes })
  }

  return (
    <div>
      {/* Bulk toolbar — sticky so it stays reachable while scrolling. */}
      <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm">
        <label className="flex items-center gap-1.5 text-xs text-neutral-600">
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
        </label>
        {selected.size > 0 ? (
          <>
            <span className="text-neutral-300">|</span>
            <button
              type="button"
              disabled={bulk.isPending}
              onClick={() => run('markRead')}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              Mark read
            </button>
            <button
              type="button"
              disabled={bulk.isPending}
              onClick={() => run('close')}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              Close
            </button>
            <select
              defaultValue=""
              disabled={bulk.isPending}
              onChange={(e) => {
                const m = Number(e.target.value)
                if (m > 0) runSnooze(m)
                e.currentTarget.value = ''
              }}
              className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs"
              aria-label="Snooze selected for"
            >
              <option value="" disabled>
                Snooze…
              </option>
              {SNOOZE_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>
                  {o.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={bulk.isPending}
              onClick={() => run('unsnooze')}
              className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
            >
              Unsnooze
            </button>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="ml-auto text-xs text-neutral-500 hover:underline"
            >
              Clear
            </button>
          </>
        ) : (
          <span className="text-xs text-neutral-400">
            Select conversations to bulk mark-read / close / snooze.
          </span>
        )}
      </div>

      <ul className="divide-y divide-neutral-100 rounded-lg border border-neutral-200 bg-white shadow-sm">
        {items.map((c) => {
          const channelLabel =
            c.channel && CHANNEL_LABEL[c.channel]
              ? CHANNEL_LABEL[c.channel]
              : (c.channel ?? 'Conversation')
          const replyWindowOpen =
            c.replyDeadlineAt && new Date(c.replyDeadlineAt).getTime() > now.getTime()
          const checked = selected.has(c.id)
          return (
            <li
              key={c.id}
              className={checked ? 'bg-primary-50/40 p-3' : 'p-3 transition hover:bg-neutral-50'}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(c.id)}
                  aria-label={`Select conversation with ${c.contactName ?? 'contact'}`}
                  className="mt-1.5"
                />
                <Link href={`/inbox/conversations/${c.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-neutral-100"
                      aria-hidden
                    >
                      <ChannelIcon channel={c.channel} />
                    </span>
                    <Badge tone="neutral">{channelLabel}</Badge>
                    <span className="truncate font-medium text-neutral-900">
                      {c.contactName ?? (c.contactId ? 'Contact' : 'Unmatched')}
                    </span>
                    {c.unreadCount > 0 ? (
                      <Badge tone="warn">{c.unreadCount} unread</Badge>
                    ) : null}
                    {c.status === 'closed' ? <Badge tone="neutral">Closed</Badge> : null}
                    {c.status === 'snoozed' ? <Badge tone="neutral">Snoozed</Badge> : null}
                    {c.channel === 'whatsapp' && c.replyDeadlineAt ? (
                      <span
                        className={`rounded px-1.5 text-[10px] ${
                          replyWindowOpen
                            ? 'bg-green-50 text-green-800'
                            : 'bg-red-50 text-red-800'
                        }`}
                      >
                        {replyWindowOpen ? '24h window open' : '24h window closed'}
                      </span>
                    ) : null}
                    {c.assigneeName ? <Badge tone="neutral">{c.assigneeName}</Badge> : null}
                    {c.tags.slice(0, 3).map((t) => (
                      <Badge key={t} tone="neutral">
                        {t}
                      </Badge>
                    ))}
                  </div>
                  {c.subject ? (
                    <p className="mt-1 truncate pl-8 text-sm text-neutral-700">{c.subject}</p>
                  ) : null}
                </Link>
                <time
                  className="shrink-0 font-mono text-xs tabular-nums text-neutral-500"
                  dateTime={c.lastMessageAt.toISOString()}
                >
                  {formatRelativeTime(c.lastMessageAt, now)}
                </time>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
