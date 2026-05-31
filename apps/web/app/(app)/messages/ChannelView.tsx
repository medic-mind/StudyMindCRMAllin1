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
import { ForwardDialog } from './ForwardDialog'
import { MessageRow } from './MessageRow'
import { PinsSavedPanel } from './PinsSavedPanel'
import { ThreadPanel } from './ThreadPanel'
import type { MessageView, ReactionEmoji } from './types'

interface Props {
  channelId: string
  viewerId: string
  canModerate: boolean
  canManageChannels: boolean
  /** CEO + Senior Manager — permanent channel deletion. */
  canDeleteChannels: boolean
  /** Open this thread on mount (deep-link from search). */
  initialThreadRootId?: string | null
  /** Called after this channel is deleted so the workspace can reselect. */
  onChannelDeleted?: (channelId: string) => void
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

export function ChannelView({
  channelId,
  viewerId,
  canModerate,
  canManageChannels,
  canDeleteChannels,
  initialThreadRootId,
  onChannelDeleted,
}: Props) {
  const utils = trpc.useUtils()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const [threadRootId, setThreadRootId] = useState<string | null>(
    initialThreadRootId ?? null,
  )
  const [forwardId, setForwardId] = useState<string | null>(null)
  const atBottomRef = useRef(true)

  const channelQuery = trpc.chat.getChannel.useQuery({ id: channelId })
  // The forward picker needs the viewer's visible channels. Cached + shared
  // with the sidebar's query, so this is effectively free.
  const channelsQuery = trpc.chat.listChannels.useQuery({})

  // Reverse-chronological pages from the server; we flatten + reverse for
  // display (oldest at top, newest at bottom) like every chat app. The SSE
  // stream (workspace-level) drives freshness; this slow poll is a safety net.
  const messagesQuery = trpc.chat.listMessages.useInfiniteQuery(
    { channelId, limit: 40 },
    {
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      refetchInterval: 30_000,
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
  const pin = trpc.chat.pin.useMutation({
    onSuccess: () => {
      void utils.chat.listMessages.invalidate({ channelId })
      void utils.chat.listPins.invalidate({ channelId })
    },
    onError: (e) => toast.error(e.message ?? 'Could not pin'),
  })
  const save = trpc.chat.save.useMutation({
    onSuccess: () => {
      void utils.chat.listMessages.invalidate({ channelId })
      void utils.chat.listSaves.invalidate()
    },
    onError: (e) => toast.error(e.message ?? 'Could not save'),
  })

  // Jump-to-message: scroll a message into view and flash a highlight. Set by
  // the Pins/Saved panels and by a deep-link. Message rows register a ref by id.
  const [jumpToId, setJumpToId] = useState<string | null>(null)
  const messageRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const registerMessageRef = (id: string, el: HTMLDivElement | null) => {
    if (el) messageRefs.current.set(id, el)
    else messageRefs.current.delete(id)
  }
  useEffect(() => {
    if (!jumpToId) return
    const el = messageRefs.current.get(jumpToId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const clear = setTimeout(() => setJumpToId(null), 2200)
      return () => clearTimeout(clear)
    }
    // The target isn't on the loaded page yet — page older messages in until it
    // appears (bounded so we never loop forever).
    if (messagesQuery.hasNextPage && !messagesQuery.isFetchingNextPage) {
      void messagesQuery.fetchNextPage()
    }
    return undefined
  }, [jumpToId, messages, messagesQuery])

  // Side panel: which secondary view (thread / pins / saved) is open, if any.
  const [panel, setPanel] = useState<'pins' | 'saved' | null>(null)

  const channel = channelQuery.data

  return (
    <div className="flex h-full min-w-0 flex-1">
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {channel ? (
          <ChannelHeader
            channel={channel}
            canManage={canManageChannels}
            canDelete={canDeleteChannels}
            onDeleted={onChannelDeleted}
            onOpenPins={() => setPanel((p) => (p === 'pins' ? null : 'pins'))}
            onOpenSaved={() => setPanel((p) => (p === 'saved' ? null : 'saved'))}
          />
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
              const highlighted = jumpToId === m.id
              return (
                <div key={m.id} ref={(el) => registerMessageRef(m.id, el)}>
                  {showDivider ? <DayDivider date={m.createdAt} /> : null}
                  <div
                    className={
                      highlighted
                        ? 'bg-amber-50 ring-1 ring-inset ring-amber-200 transition-colors'
                        : 'transition-colors'
                    }
                  >
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
                      onForward={(id) => setForwardId(id)}
                      onPin={(id, pinned) => pin.mutate({ messageId: id, pinned })}
                      onSave={(id, saved) => save.mutate({ messageId: id, saved })}
                    />
                  </div>
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
            enableAttachments
            onSend={(body, attachments) =>
              send.mutate({ channelId, body, attachments })
            }
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
      ) : panel ? (
        <PinsSavedPanel
          kind={panel}
          channelId={channelId}
          viewerId={viewerId}
          onClose={() => setPanel(null)}
          onJump={(messageId, parentId) => {
            setPanel(null)
            if (parentId) setThreadRootId(parentId)
            else setJumpToId(messageId)
          }}
          onUnpin={(id) => pin.mutate({ messageId: id, pinned: false })}
          onUnsave={(id) => save.mutate({ messageId: id, saved: false })}
        />
      ) : null}

      {forwardId ? (
        <ForwardDialog
          messageId={forwardId}
          channels={channelsQuery.data?.channels ?? []}
          currentChannelId={channelId}
          onClose={() => setForwardId(null)}
          onForwarded={() => setForwardId(null)}
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
