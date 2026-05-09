// Domain-mapped types for Aircall.
// Raw Aircall payload shapes stay inside this package; the rest of the app
// reads these typed shapes only. CLAUDE.md §10, §45.

// -----------------------------------------------------------------------------
// Webhook event names we subscribe to. CLAUDE.md §10.
// -----------------------------------------------------------------------------

export const AIRCALL_EVENT_NAMES = [
  'call.created',
  'call.ringing_on_agent',
  'call.answered',
  'call.hungup',
  'call.ended',
  'call.voicemail_left',
  'call.tagged',
  'call.commented',
  'transcription.created',
] as const

export type AircallEventName = (typeof AIRCALL_EVENT_NAMES)[number]

export function isAircallEventName(value: string): value is AircallEventName {
  return (AIRCALL_EVENT_NAMES as readonly string[]).includes(value)
}

// -----------------------------------------------------------------------------
// Mapping to our Interaction.type registry. CLAUDE.md §45 — past-tense verbs,
// dot-namespaced. Multiple Aircall event names collapse into the same
// Interaction.type (e.g. `call.ringing_on_agent` is just a started-lifecycle
// signal we record once).
// -----------------------------------------------------------------------------

export type InteractionEventName =
  | 'call.started'
  | 'call.answered'
  | 'call.ended'
  | 'call.voicemail_left'
  | 'call.tagged'
  | 'call.commented'
  | 'call.transcription_added'

export function mapAircallEventToInteraction(
  name: AircallEventName,
): InteractionEventName | null {
  switch (name) {
    case 'call.created':
    case 'call.ringing_on_agent':
      return 'call.started'
    case 'call.answered':
      return 'call.answered'
    case 'call.hungup':
    case 'call.ended':
      return 'call.ended'
    case 'call.voicemail_left':
      return 'call.voicemail_left'
    case 'call.tagged':
      return 'call.tagged'
    case 'call.commented':
      return 'call.commented'
    case 'transcription.created':
      return 'call.transcription_added'
    default:
      return null
  }
}

// -----------------------------------------------------------------------------
// Webhook envelope. Aircall posts a single event per request; the body shape
// is `{ event, resource, data, timestamp, token }`.
// -----------------------------------------------------------------------------

export interface AircallWebhookEnvelope {
  event: string
  resource: string
  /** ISO 8601 string from Aircall. */
  timestamp: string
  /** Per-account token (not used for verification — we verify the signature). */
  token?: string
  data: AircallEventData
}

/**
 * Union of the data shapes we care about. We keep the surface narrow on
 * purpose — fields not used here go to `ProviderEvent.raw`.
 */
export interface AircallEventData {
  /** Always present for `call.*` events. */
  id?: number
  direction?: 'inbound' | 'outbound'
  status?: string
  started_at?: number
  answered_at?: number | null
  ended_at?: number | null
  duration?: number
  raw_digits?: string
  /** Aircall line number metadata. */
  number?: { id?: number; digits?: string; name?: string }
  /** Counterparty contact (when Aircall has matched it on their side). */
  contact?: {
    phone_numbers?: { value: string }[]
    emails?: { value: string }[]
  } | null
  recording?: string | null
  voicemail?: string | null
  /** AI Assist transcript (only available on lines with AI Assist enabled). */
  transcription?: { content: string; language?: string } | null
  /** `transcription.created` payload references its parent call. */
  call_id?: number
  content?: string
  language?: string
  // Catch-all so we never silently drop information when storing into
  // Interaction.payload.
  [key: string]: unknown
}

/**
 * Synthetic event id used for ProviderEvent dedupe. Aircall does not send a
 * unique delivery id per webhook, so we derive one from the tuple
 * (event, data.id|call_id, timestamp). A duplicate redelivery of the same
 * (event, callId, timestamp) is therefore a true no-op in upsertProviderEvent.
 */
export function aircallEventId(envelope: AircallWebhookEnvelope): string {
  const callOrId = envelope.data.id ?? envelope.data.call_id ?? 'unknown'
  return `${envelope.event}:${String(callOrId)}:${envelope.timestamp}`
}
