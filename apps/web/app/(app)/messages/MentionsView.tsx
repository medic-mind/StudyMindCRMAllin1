// The "@you" mentions feed (ADR 0022). Slack's Mentions & reactions, scoped to
// mentions. Click an item to jump to its channel; mark one or all read.

'use client'

import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/ui/avatar'
import { AtSignIcon, CheckIcon } from '@/components/ui/icon'
import { formatRelativeTime } from '@/lib/format/relative-time'
import { trpc } from '@/lib/trpc/client'

import { MessageBody } from './MessageBody'

interface Props {
  viewerId: string
  onOpenChannel: (channelId: string) => void
}

export function MentionsView({ viewerId, onOpenChannel }: Props) {
  const utils = trpc.useUtils()
  const mentionsQuery = trpc.chat.mentions.useQuery(
    { onlyUnread: false, limit: 50 },
    { refetchInterval: 15_000 },
  )

  const markOne = trpc.chat.markMentionRead.useMutation({
    onSuccess: () => {
      void utils.chat.mentions.invalidate()
      void utils.chat.unreadSummary.invalidate()
      void utils.chat.listChannels.invalidate()
    },
  })
  const markAll = trpc.chat.markAllMentionsRead.useMutation({
    onSuccess: () => {
      toast.success('All mentions marked read')
      void utils.chat.mentions.invalidate()
      void utils.chat.unreadSummary.invalidate()
      void utils.chat.listChannels.invalidate()
    },
  })

  const items = mentionsQuery.data?.items ?? []
  const unread = items.filter((i) => !i.read).length

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-4">
        <div className="flex items-center gap-2">
          <AtSignIcon size={18} className="text-neutral-400" />
          <h1 className="text-sm font-semibold text-neutral-900">Mentions</h1>
          {unread > 0 ? (
            <span className="rounded-full bg-danger-50 px-2 py-0.5 text-[11px] font-medium text-danger-700">
              {unread} unread
            </span>
          ) : null}
        </div>
        {unread > 0 ? (
          <Button size="sm" variant="secondary" onClick={() => markAll.mutate()}>
            <CheckIcon size={14} /> Mark all read
          </Button>
        ) : null}
      </header>

      <div className="flex-1 overflow-y-auto">
        {mentionsQuery.isLoading ? (
          <p className="px-4 py-6 text-sm text-neutral-500">Loading…</p>
        ) : items.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-100 text-neutral-400">
              <AtSignIcon size={22} />
            </div>
            <p className="mt-2 text-sm font-medium text-neutral-700">No mentions yet</p>
            <p className="mt-0.5 text-sm text-neutral-500">
              When a teammate @mentions you, it shows up here.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-100">
            {items.map((m) => (
              <li
                key={m.mentionId}
                className={m.read ? 'px-4 py-3' : 'bg-primary-50/40 px-4 py-3'}
              >
                <div className="flex items-start gap-3">
                  <Avatar name={m.authorName} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-neutral-900">
                        {m.authorName}
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          markOne.mutate({ mentionId: m.mentionId })
                          onOpenChannel(m.channelId)
                        }}
                        className="truncate text-xs font-medium text-primary-700 hover:underline"
                      >
                        in {m.channelTitle}
                      </button>
                      <span className="text-[11px] text-neutral-400">
                        {formatRelativeTime(m.occurredAt)}
                      </span>
                    </div>
                    <div className="mt-0.5">
                      <MessageBody
                        body={m.body}
                        userNames={{ [viewerId]: 'you' }}
                        refs={m.refs}
                        viewerId={viewerId}
                      />
                    </div>
                  </div>
                  {!m.read ? (
                    <button
                      type="button"
                      title="Mark read"
                      aria-label="Mark mention read"
                      onClick={() => markOne.mutate({ mentionId: m.mentionId })}
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700"
                    >
                      <CheckIcon size={15} />
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
