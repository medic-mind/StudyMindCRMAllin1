// Forward-a-message dialog (ADR 0022). Pick a destination channel/DM, add an
// optional note, and re-post the original (quoted, attributed) there. Mirrors
// Slack's Forward. The destination list reuses the viewer's visible channels.

'use client'

import { useMemo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { HashIcon, LockIcon, XIcon } from '@/components/ui/icon'
import { Avatar } from '@/components/ui/avatar'
import { trpc } from '@/lib/trpc/client'

import type { ChannelView } from './types'

interface Props {
  messageId: string
  channels: ChannelView[]
  /** The channel the message is in, so we can de-emphasise re-forwarding to it. */
  currentChannelId: string
  onClose: () => void
  onForwarded: (channelId: string) => void
}

export function ForwardDialog({
  messageId,
  channels,
  currentChannelId,
  onClose,
  onForwarded,
}: Props) {
  const utils = trpc.useUtils()
  const [query, setQuery] = useState('')
  const [target, setTarget] = useState<string | null>(null)
  const [note, setNote] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const visible = channels.filter((c) => !c.archived)
    if (!q) return visible
    return visible.filter((c) => c.title.toLowerCase().includes(q))
  }, [channels, query])

  const forward = trpc.chat.forward.useMutation({
    onSuccess: (res) => {
      toast.success('Message forwarded')
      void utils.chat.listChannels.invalidate()
      if (res?.channelId) {
        void utils.chat.listMessages.invalidate({ channelId: res.channelId })
        onForwarded(res.channelId)
      } else {
        onClose()
      }
    },
    onError: (e) => toast.error(e.message ?? 'Could not forward message'),
  })

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Forward message"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-md flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-neutral-100 px-5 py-3">
          <h2 className="text-sm font-semibold text-neutral-900">Forward message</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100"
          >
            <XIcon size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <Label htmlFor="fwd-search">To</Label>
          <input
            id="fwd-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search channels and people…"
            autoFocus
            className="mt-1 w-full rounded-md border border-neutral-300 px-2.5 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
          />

          <ul className="mt-2 max-h-52 flex-1 overflow-y-auto rounded-lg border border-neutral-100">
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-xs text-neutral-500">No destinations match.</li>
            ) : (
              filtered.map((c) => {
                const selected = c.id === target
                const Icon = c.kind === 'private' ? LockIcon : HashIcon
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => setTarget(c.id)}
                      className={
                        selected
                          ? 'flex w-full items-center gap-2 bg-primary-50 px-3 py-1.5 text-left text-sm text-primary-800'
                          : 'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50'
                      }
                    >
                      {c.kind === 'dm' ? (
                        <Avatar name={c.title} size={20} />
                      ) : (
                        <Icon size={15} className="text-neutral-400" />
                      )}
                      <span className="flex-1 truncate">{c.title}</span>
                      {c.id === currentChannelId ? (
                        <span className="text-[10px] text-neutral-400">current</span>
                      ) : null}
                      {selected ? <span className="text-primary-600">✓</span> : null}
                    </button>
                  </li>
                )
              })
            )}
          </ul>

          <Label htmlFor="fwd-note" className="mt-3">
            Add a note (optional)
          </Label>
          <Textarea
            id="fwd-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Say something about this…"
            className="mt-1 min-h-[60px]"
            maxLength={4000}
          />
        </div>

        <div className="flex justify-end gap-2 border-t border-neutral-100 px-5 py-3">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={forward.isPending || !target}
            onClick={() =>
              target &&
              forward.mutate({
                messageId,
                toChannelId: target,
                note: note.trim() || undefined,
              })
            }
          >
            Forward
          </Button>
        </div>
      </div>
    </div>
  )
}
