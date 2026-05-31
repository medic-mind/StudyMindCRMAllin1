// Server-Sent Events stream for live team-messaging updates (ADR 0022 —
// "make it feel alive"). A sibling to /api/realtime/conversations, scoped to
// the chat bus.
//
// CLAUDE.md §20 (RBAC — chat is all authenticated staff, incl. virtual_assistant),
// §26 (client islands consume this via `useChatStream`).
//
// One subscription per connected browser. Pure hint channel: the payload tells
// the client which channel changed (and whether the viewer was mentioned) so it
// can invalidate the right queries and optionally fire a desktop notification.
// The DB stays the source of truth.
//
// Multi-instance fan-out rides the chat bus's Redis pub/sub (ADR 0020 Phase 7b
// plumbing, reused) when REDIS_URL is set; in-process otherwise.

import {
  REALTIME_EVENT_CHAT_ACTIVITY,
  subscribeChatActivity,
  type ChatActivityEvent,
} from '@studymind/core/realtime'

import { getCurrentUser } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Heartbeat comment every 25 s so proxies (CloudFront, nginx, Railway edge) do
// not close an idle stream.
const HEARTBEAT_MS = 25_000

export async function GET(req: Request): Promise<Response> {
  // Any authenticated staff member participates in chat — no role gate beyond
  // "signed in". The per-channel membership check lives in the tRPC reads the
  // client fires after a hint; this stream only says "something changed".
  const user = await getCurrentUser()
  if (!user) return new Response('unauthorised', { status: 401 })

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const sendEvent = (event: string, payload: unknown): void => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
          )
        } catch {
          // Stream already closed by the client — best-effort.
        }
      }

      sendEvent('hello', { userId: user.id, at: new Date().toISOString() })

      unsubscribe = subscribeChatActivity((event: ChatActivityEvent) => {
        sendEvent(REALTIME_EVENT_CHAT_ACTIVITY, event)
      })

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`))
        } catch {
          // ignore — cleanup happens on cancel
        }
      }, HEARTBEAT_MS)

      req.signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
    cancel() {
      cleanup()
    },
  })

  function cleanup(): void {
    if (heartbeat) {
      clearInterval(heartbeat)
      heartbeat = null
    }
    if (unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
