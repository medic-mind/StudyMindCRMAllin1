// Interaction view-models. See CLAUDE.md Section 26.
//
// `toInteractionListItem` also distils the JSONB payload into a small typed
// `meta` (channel, call direction/duration, outbound send state + error) so
// the Activity timeline can label rows truthfully — a real Aircall call reads
// "Inbound call · 2m 10s", a stuck Trengo send reads "failed" with the actual
// provider error — without shipping raw payloads to the client.

import type {
  InteractionListItem,
  InteractionListMeta,
  InteractionType,
} from '@studymind/core/interaction'

export type { InteractionListItem } from '@studymind/core/interaction'

interface InteractionRow {
  id: string
  type: InteractionType
  occurredAt: Date
  summary: string | null
  contactId: string | null
  familyId: string | null
  createdById: string | null
  payload?: unknown
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function deriveMeta(type: InteractionType, payload: unknown): InteractionListMeta | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const p = payload as Record<string, unknown>

  const channel = str(p['channel'])
  const direction = str(p['direction'])
  const durationSec = num(p['durationSec'])
  const rawStatus = str(p['status'])
  const lastError = p['lastError'] as { message?: unknown } | undefined
  const errorMessage =
    rawStatus === 'pending_send' || rawStatus === 'failed'
      ? (str(lastError?.message) ?? null)
      : null
  // An outbound that recorded an error but is still pending_send reads as
  // "failed" to a human — the retry cron may still recover it, but "sending"
  // would be a lie after the first hard failure.
  const status =
    rawStatus === 'pending_send' ? (errorMessage ? 'failed' : 'sending') : rawStatus

  if (!channel && !direction && durationSec === null && !status && !errorMessage) {
    return undefined
  }
  return {
    channel,
    direction,
    durationSec,
    status: type === 'message' || type === 'email_sent' ? status : null,
    error: errorMessage,
  }
}

export function toInteractionListItem(row: InteractionRow): InteractionListItem {
  const meta = deriveMeta(row.type, row.payload)
  return {
    id: row.id,
    type: row.type,
    occurredAt: row.occurredAt,
    summary: row.summary,
    authorId: row.createdById,
    contactId: row.contactId,
    familyId: row.familyId,
    ...(meta ? { meta } : {}),
  }
}
