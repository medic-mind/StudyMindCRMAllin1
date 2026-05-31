// The messaging workspace shell (ADR 0022): channel rail + active pane. Owns
// the active-channel selection (kept in the URL via ?c= and ?view=) so a link
// to a channel is shareable and the back button works.
//
// "Make it feel alive": this shell holds the single SSE subscription for the
// whole workspace (useChatStream) — live badges, live message refetch, and
// desktop notifications on incoming mentions/messages. Per-channel polling is
// retained only as a slow safety net behind the realtime stream.

'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useBrowserNotifications } from '@/lib/hooks/use-browser-notifications'
import { useChatStream, type ChatActivityPayload } from '@/lib/hooks/use-chat-stream'
import { trpc } from '@/lib/trpc/client'

import { ChannelList } from './ChannelList'
import { ChannelView } from './ChannelView'
import { MentionsView } from './MentionsView'

interface Props {
  viewerId: string
  canModerate: boolean
  canManageChannels: boolean
  canDeleteChannels: boolean
}

export function MessagesWorkspace({
  viewerId,
  canModerate,
  canManageChannels,
  canDeleteChannels,
}: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const view = searchParams.get('view')
  const channelParam = searchParams.get('c')

  // SSE drives freshness now, so the channel-list poll is a slow safety net
  // rather than the primary update path.
  const channelsQuery = trpc.chat.listChannels.useQuery(
    {},
    { refetchInterval: 60_000 },
  )
  const channels = useMemo(() => channelsQuery.data?.channels ?? [], [channelsQuery.data])

  const mentionsActive = view === 'mentions'

  // The effective active channel: explicit ?c=, else the first channel
  // (#general sorts first). Only when not on the mentions view.
  const activeChannelId = useMemo(() => {
    if (mentionsActive) return null
    if (channelParam && channels.some((c) => c.id === channelParam)) return channelParam
    return channels[0]?.id ?? null
  }, [mentionsActive, channelParam, channels])

  // Notification opt-in + firing. The browser-notification hook (shared with
  // the bell) wants a list of "notifiable items"; we feed it incoming chat
  // activity converted into that shape. State (not a ref) so a new event
  // actually re-renders and reaches the notification hook; capped to a short
  // rolling window so a burst collapses into one OS notification.
  const [incoming, setIncoming] = useState<ChatActivityPayload[]>([])
  const titleByChannel = useMemo(() => {
    const map = new Map<string, string>()
    for (const c of channels) map.set(c.id, c.title)
    return map
  }, [channels])

  // Convert incoming activity into the hook's NotifiableItem shape. Only
  // mentions are flagged "unread" so the user isn't pinged for every message in
  // a busy public channel they happen to belong to.
  const notifiableItems = useMemo(() => {
    return incoming.map((e) => {
      const isMention = e.mentionUserIds.includes(viewerId)
      const channelTitle = titleByChannel.get(e.channelId) ?? 'a channel'
      return {
        id: e.messageId ?? `${e.channelId}:${e.occurredAt}`,
        title: isMention
          ? `${e.actorName ?? 'Someone'} mentioned you in ${channelTitle}`
          : `${e.actorName ?? 'Someone'} in ${channelTitle}`,
        body: e.preview ?? '',
        occurredAt: new Date(e.occurredAt),
        unread: isMention,
      }
    })
  }, [viewerId, titleByChannel, incoming])

  const notifications = useBrowserNotifications(notifiableItems)

  useChatStream({
    viewerId,
    activeChannelId,
    onIncoming: (event) => {
      setIncoming((prev) => [...prev.slice(-19), event])
    },
  })

  const setUrl = useCallback(
    (params: { c?: string; view?: string }) => {
      const next = new URLSearchParams(searchParams.toString())
      if (params.view) {
        next.set('view', params.view)
        next.delete('c')
      } else if (params.c) {
        next.set('c', params.c)
        next.delete('view')
      }
      router.replace(`/messages?${next.toString()}`, { scroll: false })
    },
    [router, searchParams],
  )

  // Normalise the URL once channels load so refresh keeps the same channel.
  useEffect(() => {
    if (mentionsActive) return
    if (!channelParam && activeChannelId) {
      setUrl({ c: activeChannelId })
    }
  }, [mentionsActive, channelParam, activeChannelId, setUrl])

  const mentionTotal = channels.reduce((sum, c) => sum + c.mentionCount, 0)

  return (
    <div className="flex h-[calc(100vh-var(--shell-topbar-height))] overflow-hidden">
      <ChannelList
        channels={channels}
        activeId={activeChannelId}
        mentionTotal={mentionTotal}
        canManageChannels={canManageChannels}
        mentionsActive={mentionsActive}
        notifications={{
          supported: notifications.supported,
          enabled: notifications.enabled,
          permission: notifications.permission,
          enable: notifications.enable,
          disable: notifications.disable,
        }}
        onSelect={(id) => setUrl({ c: id })}
        onSelectMentions={() => setUrl({ view: 'mentions' })}
      />

      {mentionsActive ? (
        <MentionsView viewerId={viewerId} onOpenChannel={(id) => setUrl({ c: id })} />
      ) : activeChannelId ? (
        <ChannelView
          key={activeChannelId}
          channelId={activeChannelId}
          viewerId={viewerId}
          canModerate={canModerate}
          canManageChannels={canManageChannels}
          canDeleteChannels={canDeleteChannels}
          onChannelDeleted={() => router.replace('/messages', { scroll: false })}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-500">
          {channelsQuery.isLoading
            ? 'Loading…'
            : 'No channels yet. Create one to get started.'}
        </div>
      )}
    </div>
  )
}
