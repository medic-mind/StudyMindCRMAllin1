// Server-Sent Events stream for live conversation updates (ADR 0020 Phase 3).
//
// CLAUDE.md §11 (Trengo), §20 (RBAC), §26 (RSC by default — client islands
// consume this through `useConversationStream`).
//
// One subscription per connected browser. Pure hint channel — the payload
// carries just enough for the client to know which conversation changed; it
// invalidates the comms-centre query and refetches the indexed read. The DB
// remains the source of truth.
//
// Multi-instance fan-out (Redis pub/sub) is Phase 7; in single-instance
// Railway today the in-process bus is sufficient. A subscriber on instance A
// will not see a publish from instance B until then — surfaced in the audit
// doc as a known limitation.

import {
  REALTIME_EVENT_CONVERSATION_UPDATED,
  subscribeConversationUpdates,
  type ConversationUpdatedEvent,
} from '@studymind/core/realtime'

import { getCurrentUser } from '@/lib/auth/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

// SSE protocol: text/event-stream, one message per `data:` line, blank line
// between messages. We also emit a `:` comment every 25 s as a heartbeat so
// proxies (CloudFront, nginx, Railway's edge) do not close the connection.
const HEARTBEAT_MS = 25_000

export async function GET(req: Request): Promise<Response> {
  const user = await getCurrentUser()
  if (!user) return new Response('unauthorised', { status: 401 })
  if (!ALLOWED_ROLES.has(user.role)) {
    return new Response('forbidden', { status: 403 })
  }

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
          // Stream was already closed by the client — best-effort.
        }
      }

      // Tell the client we are alive. Also doubles as a sanity check that
      // proxies are not buffering the response.
      sendEvent('hello', { userId: user.id, at: new Date().toISOString() })

      unsubscribe = subscribeConversationUpdates(
        (event: ConversationUpdatedEvent) => {
          sendEvent(REALTIME_EVENT_CONVERSATION_UPDATED, event)
        },
      )

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`))
        } catch {
          // ignore — cleanup happens on cancel
        }
      }, HEARTBEAT_MS)

      // Abort signal fires when the client navigates away or refreshes.
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
      // Disable proxy buffering and any compressed encoding that would
      // delay the heartbeat.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
