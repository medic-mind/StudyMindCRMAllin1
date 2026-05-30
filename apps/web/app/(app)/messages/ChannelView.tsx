// The active channel pane (ADR 0022): header + scrollable message feed +
// composer. Polls for new messages while open, marks the channel read, and
// opens threads in the side panel.

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { HashIcon } from '@/components/ui/icon'
import { trpc } from '@/lib/trpc/client'

import { ChannelHeader } from './ChannelHeader'
import { Composer } from './Composer'
import { MessageRow } from './MessageRow'
import { ThreadPanel } from './ThreadPanel'
import type { MessageView, ReactionEmoji } from './types'

interface Props {
  channelId: string
  viewerId: string
  canModerate: boolean
  canManageChannels: boolean
}

function dayKey(d: Date): string {
  return new Date(d).toDateString()
}

function DayDivider({ date }: { date: Date }) {
  const label = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date)
  return (
    <div className="my-2 flex items-center gap-3 px-4">
      <span className="h-px flex-1 bg-neutral-200" />
      <span className="rounded-full border border-neutral-200 bg-white px-2.5 py-0.5 text-[11px] font-medium text-neutral-500">
        {label}
      </span>
      <span className="h-px flex-1 bg-neutral-200" />
    </div>
  )
}

export function ChannelView({ channelId, viewerId, canModerate, canManageChannels }: Props) {
  const utils = trpc.useUtils()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [threadRootId, setThreadRootId] = useState<string | null>(null)
  const atBottomRef = useRef(true)

  const channelQuery = trpc.chat.getChannel.useQuery({ id: channelId })

  // Reverse-chronological pages from the server; we flatten + reverse for
  // display (oldest at top, newest at bottom) like every chat app.
  const messagesQuery = trpc.chat.listMessages.useInfiniteQuery(
    { channelId, limit: 40 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      refetchInterval: 4000,
      refetchIntervalInBackground: false,
    },
  )

  const messages: MessageView[] = useMemo(() => {
    const pages = messagesQuery.data?.pages ?? []
    // Each page is newest-first; concat then reverse → oldest-first overall.
    const flat = pages.flatMap((p) => p.items)
    return [...flat].reverse()
  }, [messagesQuery.data])

  // Names map for rendering @mentions across the visible set.
  const userNames = useMemo(() => {
    const map: Record<string, string> = {}
    for (const m of messages) map[m.authorId] = m.authorName
    return map
  }, [messages])

  const markRead = trpc.chat.markRead.useMutation({
    onSuccess: () => {
      void utils.chat.listChannels.invalidate()
      void utils.chat.unreadSummary.invalidate()
    },
  })

  // Mark read whenever the channel changes or new messages arrive while the
  // pane is focused at the bottom.
  const newestId = messages[messages.length - 1]?.id
  // Keyed on channel + newest message: mark read on open and as new messages
  // arrive. react-query's `.mutate` is referentially stable, so depending on it
  // (rather than the whole mutation object) keeps this effect from re-running
  // every render.
  const markReadMutate = markRead.mutate
  useEffect(() => {
    if (!channelId) return
    markReadMutate({ channelId })
  }, [channelId, newestId, markReadMutate])

  // Track whether the user is pinned to the bottom so we only auto-scroll then.
  function onScroll() {
    const el = scrollRef.current
    if (!el) return
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }
  useEffect(() => {
    // Auto-scroll to the newest message only when the user is pinned to the
    // bottom; the refs are stable so newestId is the meaningful dependency.
    if (atBottomRef.current) {
      bottomRef.current?.scrollIntoView({ block: 'end' })
    }
  }, [newestId])

  const send = trpc.chat.send.useMutation({
    onSuccess: () => {
      atBottomRef.current = true
      void utils.chat.listMessages.invalidate({ channelId })
      void utils.chat.listChannels.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not send'),
  })
  const react = trpc.chat.react.useMutation({
    onSuccess: () => utils.chat.listMessages.invalidate({ channelId }),
  })
  const edit = trpc.chat.edit.useMutation({
    onSuccess: () => utils.chat.listMessages.invalidate({ channelId }),
    onError: (e) => toast.error(e.message ?? 'Could not edit'),
  })
  const remove = trpc.chat.remove.useMutation({
    onSuccess: () => utils.chat.listMessages.invalidate({ channelId }),
    onError: (e) => toast.error(e.message ?? 'Could not delete'),
  })

  const channel = channelQuery.data

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {channel ? (
          <ChannelHeader channel={channel} canManage={canManageChannels} />
        ) : (
          <div className="h-14 shrink-0 border-b border-neutral-200 bg-white" />
        )}

        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="flex-1 overflow-y-auto py-3"
        >
          {/* Load older */}
          {messagesQuery.hasNextPage ? (
            <div className="flex justify-center py-2">
              <button
                type="button"
                onClick={() => messagesQuery.fetchNextPage()}
                disabled={messagesQuery.isFetchingNextPage}
                className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-50"
              >
                {messagesQuery.isFetchingNextPage ? 'Loading…' : 'Load earlier messages'}
              </button>
            </div>
          ) : (
            <ChannelIntro
              title={channel?.title ?? 'this channel'}
              isDm={channel?.kind === 'dm'}
            />
          )}

          {messagesQuery.isLoading ? (
            <p className="px-4 py-6 text-sm text-neutral-500">Loading messages…</p>
          ) : messages.length === 0 ? (
            <p className="px-4 py-6 text-sm text-neutral-500">
              No messages yet — say hello to get the conversation started.
            </p>
          ) : (
            messages.map((m, i) => {
              const prev = messages[i - 1]
              const showDivider = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt)
              return (
                <div key={m.id}>
                  {showDivider ? <DayDivider date={m.createdAt} /> : null}
                  <MessageRow
                    message={m}
                    viewerId={viewerId}
                    canModerate={canModerate}
                    userNames={userNames}
                    onReact={(messageId, emoji) =>
                      react.mutate({ messageId, emoji: emoji as ReactionEmoji })
                    }
                    onOpenThread={(rootId) => setThreadRootId(rootId)}
                    onEdit={(id, body) => edit.mutate({ id, body })}
                    onDelete={(id) => remove.mutate({ id })}
                  />
                </div>
              )
            })
          )}
          <div ref={bottomRef} />
        </div>

        <div className="shrink-0 border-t border-neutral-200 bg-white px-4 py-3">
          <Composer
            placeholder={
              channel
                ? channel.kind === 'dm'
                  ? `Message ${channel.title}`
                  : `Message #${channel.name ?? channel.title}`
                : 'Message'
            }
            sending={send.isPending}
            disabled={channel?.archived}
            onSend={(body) => send.mutate({ channelId, body })}
          />
        </div>
      </div>

      {threadRootId ? (
        <ThreadPanel
          rootId={threadRootId}
          viewerId={viewerId}
          canModerate={canModerate}
          onClose={() => setThreadRootId(null)}
        />
      ) : null}
    </div>
  )
}

function ChannelIntro({ title, isDm }: { title: string; isDm: boolean }) {
  return (
    <div className="px-4 pb-3 pt-2">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-600">
        <HashIcon size={22} />
      </div>
      <h2 className="mt-2 text-lg font-semibold text-neutral-900">
        {isDm ? title : `#${title.replace(/^#/, '')}`}
      </h2>
      <p className="mt-0.5 text-sm text-neutral-500">
        {isDm
          ? 'This is the very beginning of your direct message history.'
          : 'This is the start of the channel. Share updates, ask questions, and reference customers inline.'}
      </p>
    </div>
  )
}
