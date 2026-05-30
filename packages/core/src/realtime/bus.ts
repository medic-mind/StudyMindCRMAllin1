// In-process event bus for live updates (ADR 0020 Phase 3).
//
// Single-instance for now: subscribers across multiple Railway replicas
// will not see each other's emits until we wire the bus through Redis
// pub/sub in Phase 7. The SSE route holds one subscription per connected
// browser; emitters (the Trengo webhook job and the audited outbound) call
// `publishConversationUpdate` after the Conversation head is written.
//
// CLAUDE.md §11, §17 — the bus does not retry or persist; it is a hint to
// the UI that a refetch is worth doing. The DB remains the source of truth.

import { EventEmitter } from 'node:events'

const emitter = new EventEmitter()
// Generous ceiling — every SSE subscriber adds one listener. Default 10 is
// too low for a small ops team browsing the comms centre.
emitter.setMaxListeners(0)

export const REALTIME_EVENT_CONVERSATION_UPDATED = 'conversation.updated' as const

export interface ConversationUpdatedEvent {
  /** Conversation row id (cuid2). */
  id: string
  /** Trengo ticket id — keyed in case the client wants to ignore irrelevant
   *  conversations without a refetch round-trip. */
  trengoTicketId: number
  /** ISO timestamp the row's lastMessageAt was advanced to (or null when the
   *  upsert touched only metadata). */
  lastMessageAt: string | null
  /** Optional contactId so a per-contact subscriber can ignore unrelated
   *  conversations. */
  contactId: string | null
}

export function publishConversationUpdate(event: ConversationUpdatedEvent): void {
  emitter.emit(REALTIME_EVENT_CONVERSATION_UPDATED, event)
}

export type ConversationUpdatedListener = (event: ConversationUpdatedEvent) => void

/**
 * Subscribe to conversation-update events. Returns the unsubscribe function;
 * callers MUST call it on disconnect to avoid leaking listeners. The SSE
 * route does this in the stream's `cancel`.
 */
export function subscribeConversationUpdates(
  listener: ConversationUpdatedListener,
): () => void {
  emitter.on(REALTIME_EVENT_CONVERSATION_UPDATED, listener)
  return () => {
    emitter.off(REALTIME_EVENT_CONVERSATION_UPDATED, listener)
  }
}

/** Test-only — flushes every listener so a re-run starts clean. */
export function _clearAllSubscribers(): void {
  emitter.removeAllListeners()
}
