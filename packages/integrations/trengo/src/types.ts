// Domain-mapped types for Trengo.
// Raw Trengo payload shapes stay inside this package; the rest of the app
// reads these typed shapes only. CLAUDE.md §11.

// -----------------------------------------------------------------------------
// Channels. CLAUDE.md §11 — channel-specific quirks live in
// channels/<name>.ts; this enum is the registry.
// -----------------------------------------------------------------------------

export const TRENGO_CHANNELS = ['whatsapp', 'sms', 'email', 'web_chat'] as const
export type TrengoChannel = (typeof TRENGO_CHANNELS)[number]

export function isTrengoChannel(value: string): value is TrengoChannel {
  return (TRENGO_CHANNELS as readonly string[]).includes(value)
}

// -----------------------------------------------------------------------------
// Webhook event names. CLAUDE.md §11.
// Trengo's actual event names vary across versions; we normalise to a stable
// internal set and accept either underscored or dotted variants.
// -----------------------------------------------------------------------------

export const TRENGO_EVENT_NAMES = [
  'message.inbound',
  'message.outbound',
  'ticket.assigned',
  'ticket.closed',
  'ticket.reopened',
  'label.added',
  'label.removed',
] as const

export type TrengoEventName = (typeof TRENGO_EVENT_NAMES)[number]

const TRENGO_EVENT_ALIASES: Record<string, TrengoEventName> = {
  // Older Trengo webhooks use these names; map to ours.
  message_created: 'message.inbound',
  message_inbound: 'message.inbound',
  message_outbound: 'message.outbound',
  ticket_assigned: 'ticket.assigned',
  ticket_closed: 'ticket.closed',
  ticket_reopened: 'ticket.reopened',
  label_attached: 'label.added',
  label_added: 'label.added',
  label_detached: 'label.removed',
  label_removed: 'label.removed',
}

export function normaliseTrengoEvent(raw: string): TrengoEventName | null {
  if ((TRENGO_EVENT_NAMES as readonly string[]).includes(raw)) {
    return raw as TrengoEventName
  }
  return TRENGO_EVENT_ALIASES[raw] ?? null
}

// -----------------------------------------------------------------------------
// Webhook envelope. Each Trengo POST is a single event.
// -----------------------------------------------------------------------------

export interface TrengoWebhookEnvelope {
  /** Stable id per delivery; used for ProviderEvent dedupe. */
  id: string
  /** Raw event name as Trengo sends it; we normalise via normaliseTrengoEvent. */
  event: string
  /** ISO timestamp. */
  occurred_at: string
  data: TrengoEventData
}

export interface TrengoEventData {
  /** Ticket / conversation id. */
  ticket_id?: number
  message_id?: number
  /** Direction for messages. */
  direction?: 'inbound' | 'outbound'
  /** Channel name as sent by Trengo (whatsapp, sms, email, web_chat, ...). */
  channel?: string
  /** Counterparty contact details — used for matching. */
  contact?: {
    phone?: string
    email?: string
    name?: string
  }
  body?: string
  /** Outbound metadata we attached on send (CLAUDE.md §11). */
  custom_fields?: {
    interactionId?: string
    agentId?: string
  }
  /** Ticket lifecycle fields. */
  assignee_id?: number
  label?: { id: number; name: string }
  // Catch-all so we never silently drop information into the timeline.
  [key: string]: unknown
}
