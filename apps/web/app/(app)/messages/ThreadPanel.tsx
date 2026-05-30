// Slide-over thread panel (ADR 0022). Shows a root message and its replies,
// with its own composer that posts into the thread. Polls while open.

'use client'

import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'

import { XIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { MessageRow } from './MessageRow'
import { Composer } from './Composer'
import type { MessageView, ReactionEmoji } from './types'

interface Props {
  rootId: string
  viewerId: string
  canModerate: boolean
  onClose: () => void
}

export function ThreadPanel({ rootId, viewerId, canModerate, onClose }: Props) {
  const utils = trpc.useUtils()
  const threadQuery = trpc.chat.thread.useQuery(
    { rootId },
    { refetchInterval: 5000 },
  )

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const userNames = useMemo(() => {
    const map: Record<string, string> = {}
    const all: MessageView[] = [
      ...(threadQuery.data ? [threadQuery.data.root] : []),
      ...(threadQuery.data?.replies ?? []),
    ]
    for (const m of all) map[m.authorId] = m.authorName
    return map
  }, [threadQuery.data])

  function invalidate() {
    void utils.chat.thread.invalidate({ rootId })
    void utils.chat.listMessages.invalidate()
  }

  const send = trpc.chat.send.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message ?? 'Could not send reply'),
  })
  const react = trpc.chat.react.useMutation({ onSuccess: invalidate })
  const edit = trpc.chat.edit.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message ?? 'Could not edit'),
  })
  const remove = trpc.chat.remove.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message ?? 'Could not delete'),
  })

  const root = threadQuery.data?.root
  const replies = threadQuery.data?.replies ?? []

  return (
    <aside
      className="flex w-full max-w-md shrink-0 flex-col border-l border-neutral-200 bg-white"
      aria-label="Thread"
    >
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-neutral-200 px-4">
        <h2 className="text-sm font-semibold text-neutral-900">Thread</h2>
        <button
          type="button"
          aria-label="Close thread"
          onClick={onClose}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800"
        >
          <XIcon size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-2">
        {root ? (
          <>
            <MessageRow
              message={root}
              viewerId={viewerId}
              canModerate={canModerate}
              userNames={userNames}
              showThreadAffordance={false}
              onReact={(messageId, emoji) =>
                react.mutate({ messageId, emoji: emoji as ReactionEmoji })
              }
              onEdit={(id, body) => edit.mutate({ id, body })}
              onDelete={(id) => remove.mutate({ id })}
            />
            <div className="my-2 flex items-center gap-3 px-4">
              <span className="text-xs font-medium text-neutral-400">
                {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
              </span>
              <span className="h-px flex-1 bg-neutral-200" />
            </div>
            {replies.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                viewerId={viewerId}
                canModerate={canModerate}
                userNames={userNames}
                showThreadAffordance={false}
                onReact={(messageId, emoji) =>
                react.mutate({ messageId, emoji: emoji as ReactionEmoji })
              }
                onEdit={(id, body) => edit.mutate({ id, body })}
                onDelete={(id) => remove.mutate({ id })}
              />
            ))}
          </>
        ) : (
          <p className="px-4 py-6 text-sm text-neutral-500">Loading thread…</p>
        )}
      </div>

      <div className="shrink-0 border-t border-neutral-200 p-3">
        <Composer
          placeholder="Reply…"
          sending={send.isPending}
          onSend={(body) =>
            root && send.mutate({ channelId: root.channelId, body, parentId: root.id })
          }
        />
      </div>
    </aside>
  )
}
