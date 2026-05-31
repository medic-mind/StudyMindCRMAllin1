// The messaging workspace shell (ADR 0022): channel rail + active pane. Owns
// the active-channel selection (kept in the URL via ?c= and ?view=) so a link
// to a channel is shareable and the back button works.

'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useMemo } from 'react'

import { trpc } from '@/lib/trpc/client'

import { ChannelList } from './ChannelList'
import { ChannelView } from './ChannelView'
import { MentionsView } from './MentionsView'

interface Props {
  viewerId: string
  canModerate: boolean
  canManageChannels: boolean
}

export function MessagesWorkspace({ viewerId, canModerate, canManageChannels }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const view = searchParams.get('view')
  const channelParam = searchParams.get('c')

  const channelsQuery = trpc.chat.listChannels.useQuery(
    {},
    { refetchInterval: 10_000 },
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
