// Client hook that opens an SSE stream to /api/realtime/conversations and
// invalidates the comms-centre query when a conversation changes.
//
// ADR 0020 Phase 3. The browser's native EventSource handles reconnection;
// we add a small safety net that re-establishes after a fatal error with a
// capped backoff so a transient Railway restart doesn't leave the page stale.

'use client'

import { useEffect } from 'react'

import { trpc } from '@/lib/trpc/client'

const STREAM_URL = '/api/realtime/conversations'
const RECONNECT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 15_000] as const

interface ConversationUpdatedPayload {
  id: string
  /** Null for non-Trengo rows — ADR 0021 Phase 3a. */
  trengoTicketId: number | null
  lastMessageAt: string | null
  contactId: string | null
}

export function useConversationStream(): void {
  const utils = trpc.useUtils()

  useEffect(() => {
    let cancelled = false
    let source: EventSource | null = null
    let attempt = 0
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null

    const open = () => {
      if (cancelled) return
      try {
        source = new EventSource(STREAM_URL)
      } catch {
        scheduleReconnect()
        return
      }

      source.addEventListener('hello', () => {
        // Successful connect — reset the backoff so any later failure starts
        // over at the smallest delay.
        attempt = 0
      })

      source.addEventListener('conversation.updated', (event) => {
        try {
          const data = JSON.parse(
            (event as MessageEvent).data,
          ) as ConversationUpdatedPayload
          // Invalidate the comms-centre query. TanStack will refetch in the
          // background and the list re-renders with the new row state. The
          // contactId-scoped channel query is also invalidated so per-contact
          // pages stay in sync.
          void utils.inbox.conversations.list.invalidate()
          // ADR 0021 Phase 4 — keep the /mail client live too.
          void utils.mail.threads.list.invalidate()
          if (data.contactId) {
            void utils.contact.channels.trengoConversations.invalidate({
              contactId: data.contactId,
            })
          }
          // ADR 0020 Phase 5 + 3 tie-in: a conversation update almost always
          // implies a new audit row aimed at the assignee (assignment, close,
          // reopen, message). Nudge the bell so the unread badge stays
          // current without waiting for the 30 s staleTime.
          void utils.notifications.list.invalidate()
        } catch {
          // Malformed payload — ignore. The next event (or the periodic
          // refetch in TanStack) will recover.
        }
      })

      source.addEventListener('error', () => {
        // The browser will auto-retry an SSE connection on most errors, but
        // we add our own backoff path for the cases where it gives up
        // (e.g. the response was a 5xx). Close and reschedule.
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
