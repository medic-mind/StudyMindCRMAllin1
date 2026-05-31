// Tiny client island that wires the SSE hook into the Comms Centre page.
// ADR 0020 Phase 3. Renders nothing — the hook subscribes for the lifetime
// of the page and TanStack handles the actual list refresh.

'use client'

import { useConversationStream } from '@/lib/hooks/use-conversation-stream'

export function LiveUpdates(): null {
  useConversationStream()
  return null
}
