// Trengo conversation toolbar (ADR 0020 Phase 6f). Labels (tags) and
// mark-read — the operational actions Trengo offers, surfaced on the thread
// and synced back to Trengo. Mounted only for Trengo conversations (email has
// its own MailThreadActions). Internal notes are handled by the shared
// ConversationNotes panel below (which also pushes to Trengo). Sales
// Executive+ for labels; the server enforces it.

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

import { trpc } from '@/lib/trpc/client'

interface Props {
  conversationId: string
  contactId: string | null
  ticketId: number | null
  tags: string[]
  unread: boolean
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
}

const SNOOZE_OPTIONS: ReadonlyArray<{ label: string; minutes: number }> = [
  { label: '1 hour', minutes: 60 },
  { label: '4 hours', minutes: 240 },
  { label: 'Tomorrow', minutes: 60 * 24 },
  { label: '3 days', minutes: 60 * 24 * 3 },
  { label: 'Next week', minutes: 60 * 24 * 7 },
]

export function TrengoThreadActions({
  conversationId,
  contactId,
  ticketId,
  tags,
  unread,
  status,
}: Props) {
  const router = useRouter()
  const utils = trpc.useUtils()
  const [newLabel, setNewLabel] = useState('')

  const canTag = contactId !== null && ticketId !== null

  const refresh = () => {
    void utils.inbox.conversations.get.invalidate({ conversationId })
    void utils.inbox.conversations.list.invalidate()
    router.refresh()
  }

  const labels = trpc.interaction.trengo.availableLabels.useQuery(undefined, {
    enabled: canTag,
    retry: false,
    staleTime: 5 * 60_000,
  })

  const addLabel = trpc.interaction.trengo.addLabel.useMutation({
    onSuccess: () => {
      setNewLabel('')
      toast.success('Label added')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not add label'),
  })
  const removeLabel = trpc.interaction.trengo.removeLabel.useMutation({
    onSuccess: () => {
      toast.success('Label removed')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not remove label'),
  })
  const markRead = trpc.interaction.trengo.markRead.useMutation({
    onSuccess: () => {
      toast.success('Marked read')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not mark read'),
  })
  const markUnread = trpc.interaction.trengo.markUnread.useMutation({
    onSuccess: () => {
      toast.success('Marked unread')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not mark unread'),
  })
  const snooze = trpc.interaction.trengo.snooze.useMutation({
    onSuccess: () => {
      toast.success('Snoozed')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not snooze'),
  })
  const unsnooze = trpc.interaction.trengo.unsnooze.useMutation({
    onSuccess: () => {
      toast.success('Back in the inbox')
      refresh()
    },
    onError: (e) => toast.error(e.message ?? 'Could not unsnooze'),
  })

  const busy =
    addLabel.isPending ||
    removeLabel.isPending ||
    markRead.isPending ||
    markUnread.isPending ||
    snooze.isPending ||
    unsnooze.isPending

  const submitLabel = () => {
    const v = newLabel.trim()
    if (!v || !canTag || !contactId || ticketId === null) return
    addLabel.mutate({ contactId, ticketId, label: v })
  }

  return (
    <div className="mb-4 rounded-lg border border-neutral-200 bg-white p-3 text-sm shadow-sm">
      {/* Labels */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-500">
          Labels
        </span>
        {tags.length === 0 ? (
          <span className="text-xs text-neutral-400">none</span>
        ) : (
          tags.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-neutral-50 px-2 py-0.5 text-xs text-neutral-700"
            >
              {t}
              {canTag ? (
                <button
                  type="button"
                  aria-label={`Remove label ${t}`}
                  disabled={busy}
                  onClick={() =>
                    contactId &&
                    ticketId !== null &&
                    removeLabel.mutate({ contactId, ticketId, label: t })
                  }
                  className="text-neutral-400 hover:text-danger-600 disabled:opacity-50"
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}
      </div>

      {/* Add a label — the workspace's Trengo labels as one-click chips (an
          in-app picker, not the browser's datalist dropdown), plus a free
          input for brand-new labels (created in Trengo on first use). */}
      {canTag ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            Add label
          </span>
          {(labels.data ?? [])
            .filter((l) => !tags.includes(l.name))
            .slice(0, 10)
            .map((l) => (
              <button
                key={l.id}
                type="button"
                disabled={busy}
                onClick={() =>
                  contactId &&
                  ticketId !== null &&
                  addLabel.mutate({ contactId, ticketId, label: l.name })
                }
                className="rounded-full border border-dashed border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-600 transition-colors hover:border-primary-300 hover:bg-primary-50 hover:text-primary-700 disabled:opacity-50"
              >
                + {l.name}
              </button>
            ))}
          <span className="inline-flex items-center gap-1">
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitLabel()
                }
              }}
              placeholder="New label…"
              aria-label="New label name"
              className="w-28 rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs"
            />
            <button
              type="button"
              onClick={submitLabel}
              disabled={busy || !newLabel.trim()}
              className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              Add
            </button>
          </span>
        </div>
      ) : null}

      {/* Actions row */}
      <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-2">
        {unread ? (
          <button
            type="button"
            onClick={() => markRead.mutate({ conversationId })}
            disabled={busy}
            className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            Mark read
          </button>
        ) : (
          <button
            type="button"
            onClick={() => markUnread.mutate({ conversationId })}
            disabled={busy}
            className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            Mark unread
          </button>
        )}

        {status === 'snoozed' ? (
          <button
            type="button"
            onClick={() => unsnooze.mutate({ conversationId })}
            disabled={busy}
            className="rounded border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs text-amber-800 hover:bg-amber-100 disabled:opacity-50"
          >
            Unsnooze
          </button>
        ) : (
          <span className="inline-flex items-center gap-1">
            <span className="text-xs text-neutral-500">Snooze</span>
            <select
              defaultValue=""
              disabled={busy}
              onChange={(e) => {
                const m = Number(e.target.value)
                if (m > 0) snooze.mutate({ conversationId, minutes: m })
                e.currentTarget.value = ''
              }}
              className="rounded border border-neutral-300 bg-white px-1.5 py-1 text-xs"
              aria-label="Snooze for"
            >
              <option value="" disabled>
                for…
              </option>
              {SNOOZE_OPTIONS.map((o) => (
                <option key={o.minutes} value={o.minutes}>
                  {o.label}
                </option>
              ))}
            </select>
          </span>
        )}
        <span className="ml-auto text-xs text-neutral-400">labels sync to Trengo</span>
      </div>
    </div>
  )
}
