// Client hook: opens an SSE stream to /api/realtime/chat and keeps the
// messaging UI live without polling (ADR 0022 — "make it feel alive").
//
// On each activity hint it invalidates exactly the affected TanStack queries:
//   - the channel list (unread/mention badges + last-message ordering)
//   - the workspace unread summary (top-bar badge)
//   - the active channel's message page (when the event is for that channel)
//   - the open thread (when the event is for that thread root)
//   - the mentions inbox (when the viewer was @mentioned)
//
// It also surfaces the latest *incoming* activity (someone else's, aimed at a
// channel the viewer cares about) via a callback so the workspace can raise a
// desktop notification. The browser's EventSource auto-reconnects; we add a
// capped backoff for the cases where it gives up (mirrors useConversationStream).

'use client'

import { useEffect, useRef } from 'react'

import { trpc } from '@/lib/trpc/client'

const STREAM_URL = '/api/realtime/chat'
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const

export interface ChatActivityPayload {
  kind: 'message' | 'edit' | 'delete' | 'reaction' | 'read'
  channelId: string
  messageId: string | null
  parentId: string | null
  actorId: string
  actorName: string | null
  mentionUserIds: string[]
  preview: string | null
  occurredAt: string
}

interface Options {
  /** The viewer's user id — so we skip self-authored events for notifications. */
  viewerId: string
  /** The channel currently open (so we know to refetch its message page). */
  activeChannelId?: string | null
  /** The thread root currently open, if any. */
  activeThreadRootId?: string | null
  /** Fired for genuinely incoming activity (someone else's). The workspace
   *  uses this to raise desktop notifications; the hook itself never touches
   *  the Notification API so it stays render-safe. */
  onIncoming?: (event: ChatActivityPayload) => void
}

export function useChatStream(options: Options): void {
  const utils = trpc.useUtils()

  // Keep the latest options in a ref so the EventSource effect can stay mounted
  // across re-renders (active channel changes shouldn't tear down the stream).
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const handle = (payload: ChatActivityPayload) => {
      const { viewerId, activeChannelId, activeThreadRootId, onIncoming } =
        optionsRef.current

      // Badges + sidebar ordering always refresh.
      void utils.chat.listChannels.invalidate()
      void utils.chat.unreadSummary.invalidate()

      // The active channel's message list refreshes when the event is for it.
      if (payload.channelId === activeChannelId) {
        void utils.chat.listMessages.invalidate({ channelId: payload.channelId })
      }
      // The open thread refreshes when the event belongs to it (the root itself
      // or one of its replies).
      if (
        activeThreadRootId &&
        (payload.messageId === activeThreadRootId ||
          payload.parentId === activeThreadRootId)
      ) {
        void utils.chat.thread.invalidate({ rootId: activeThreadRootId })
      }
      // The mentions inbox refreshes when the viewer was named.
      if (payload.mentionUserIds.includes(viewerId)) {
        void utils.chat.mentions.invalidate()
      }

      // Desktop-notification hook: only genuinely incoming new messages from
      // someone else. Edits/reactions/reads never ping.
      if (
        payload.kind === 'message' &&
        payload.actorId !== viewerId &&
        onIncoming
      ) {
        onIncoming(payload)
      }
    }

    const open = () => {
      if (cancelled) return
      try {
        source = new EventSource(STREAM_URL)
      } catch {
        scheduleReconnect()
        return
      }

      source.addEventListener('hello', () => {
        attempt = 0
      })

      source.addEventListener('chat.activity', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as ChatActivityPayload
          handle(data)
        } catch {
          // Malformed payload — ignore; the next event (or a TanStack refetch)
          // recovers.
        }
      })

      source.addEventListener('error', () => {
        source?.close()
        source = null
        scheduleReconnect()
      })
    }

    const scheduleReconnect = () => {
      if (cancelled) return
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
      attempt += 1
      reconnectTimer = setTimeout(open, delay)
    }

    open()

    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      source?.close()
    }
  }, [utils])
}
