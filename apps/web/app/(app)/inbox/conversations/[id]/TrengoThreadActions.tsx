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
}

export function TrengoThreadActions({
  conversationId,
  contactId,
  ticketId,
  tags,
  unread,
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

  const busy = addLabel.isPending || removeLabel.isPending || markRead.isPending

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
        {canTag ? (
          <span className="inline-flex items-center gap-1">
            <input
              list="trengo-label-options"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  submitLabel()
                }
              }}
              placeholder="Add label…"
              className="w-28 rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs"
            />
            <datalist id="trengo-label-options">
              {(labels.data ?? []).map((l) => (
                <option key={l.id} value={l.name} />
              ))}
            </datalist>
            <button
              type="button"
              onClick={submitLabel}
              disabled={busy || !newLabel.trim()}
              className="rounded bg-neutral-900 px-2 py-0.5 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
            >
              Add
            </button>
          </span>
        ) : null}
      </div>

      {/* Actions row */}
      {unread ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-neutral-100 pt-2">
          <button
            type="button"
            onClick={() => markRead.mutate({ conversationId })}
            disabled={markRead.isPending}
            className="rounded border border-neutral-300 bg-white px-2.5 py-1 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
          >
            Mark read
          </button>
          <span className="text-xs text-neutral-400">labels sync to Trengo</span>
        </div>
      ) : null}
    </div>
  )
}
