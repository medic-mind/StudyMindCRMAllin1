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
  // ADR 0020 Phase 6c — counterparty edited their details in Trengo. We do
  // NOT silently apply this (CLAUDE.md §3) — the job writes a
  // ContactFieldSuggestion the staff review queue surfaces.
  'contact.updated',
] as const

export type TrengoEventName = (typeof TRENGO_EVENT_NAMES)[number]

const TRENGO_EVENT_ALIASES: Record<string, TrengoEventName> = {
  // Trengo's event spellings vary across versions and webhook templates
  // ("INBOUND_MESSAGE", "Inbound message", "message.inbound", …). Keys here
  // are the canonical lowercase-underscore form every raw value is folded to.
  message_created: 'message.inbound',
  message_inbound: 'message.inbound',
  inbound_message: 'message.inbound',
  message_received: 'message.inbound',
  message_outbound: 'message.outbound',
  outbound_message: 'message.outbound',
  message_sent: 'message.outbound',
  ticket_assigned: 'ticket.assigned',
  ticket_closed: 'ticket.closed',
  ticket_reopened: 'ticket.reopened',
  label_attached: 'label.added',
  label_added: 'label.added',
  ticket_label_added: 'label.added',
  label_detached: 'label.removed',
  label_removed: 'label.removed',
  ticket_label_removed: 'label.removed',
  contact_updated: 'contact.updated',
}

export function normaliseTrengoEvent(raw: string): TrengoEventName | null {
  if ((TRENGO_EVENT_NAMES as readonly string[]).includes(raw)) {
    return raw as TrengoEventName
  }
  // Case/separator-insensitive fold: "INBOUND_MESSAGE" / "Inbound message" /
  // "message.inbound" all reach the alias table. An unrecognised name still
  // returns null (skipped + logged upstream) — we fail closed on semantics,
  // not on spelling (§8).
  const key = raw.trim().toLowerCase().replace(/[\s.-]+/g, '_')
  return TRENGO_EVENT_ALIASES[key] ?? null
}

/**
 * Trengo ids (ticket_id, message_id, assignee_id) arrive as numbers from
 * some workspaces and as numeric strings from others (webhook payload
 * templates stringify). Everything downstream keys on the NUMBER — the
 * Conversation head's unique trengoTicketId, the thread join on
 * payload.ticketId — so a stringly id silently orphaned the message from
 * its conversation. Fold both forms.
 */
export function coerceTrengoId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return null
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

export interface TrengoAttachment {
  /** Trengo's id (numeric) so the S3 key can dedupe across deliveries. */
  id?: number | string
  /** Direct download URL Trengo provides. We fetch through `safeFetch`
   *  so the host is allowlisted (CLAUDE.md §44.2). */
  url?: string
  filename?: string
  /** `mime_type` is the Trengo field name; we also accept `content_type`. */
  mime_type?: string
  content_type?: string
  size?: number
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
  /** ADR 0020 Phase 6d — message attachments. Trengo's exact shape varies
   *  by channel; we read both common spellings and normalise in
   *  `normaliseTrengoAttachment`. */
  attachments?: TrengoAttachment[]
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

/**
 * Normalise an attachment that arrived on a Trengo webhook to a consistent
 * shape. Returns `null` when the row is missing essentials (url + a name
 * we can sanitise). Exported for tests.
 */
export interface NormalisedTrengoAttachment {
  /** Stable id used to dedupe on the S3 key. Falls back to a hash of the
   *  url when Trengo did not include an id. */
  id: string
  url: string
  filename: string
  mimeType: string
  sizeBytes: number | null
}

export function normaliseTrengoAttachment(
  raw: TrengoAttachment,
): NormalisedTrengoAttachment | null {
  if (typeof raw.url !== 'string' || raw.url.trim() === '') return null
  const filename =
    typeof raw.filename === 'string' && raw.filename.trim() !== ''
      ? raw.filename.trim()
      : deriveFilenameFromUrl(raw.url)
  if (!filename) return null
  const id =
    typeof raw.id === 'string'
      ? raw.id
      : typeof raw.id === 'number'
        ? String(raw.id)
        : simpleHash(raw.url)
  const mimeType =
    typeof raw.mime_type === 'string' && raw.mime_type !== ''
      ? raw.mime_type
      : typeof raw.content_type === 'string' && raw.content_type !== ''
        ? raw.content_type
        : 'application/octet-stream'
  const sizeBytes = typeof raw.size === 'number' && raw.size >= 0 ? raw.size : null
  return { id, url: raw.url, filename, mimeType, sizeBytes }
}

function deriveFilenameFromUrl(url: string): string | null {
  try {
    const u = new URL(url)
    const tail = u.pathname.split('/').filter(Boolean).pop() ?? null
    return tail && tail.length > 0 ? decodeURIComponent(tail) : null
  } catch {
    return null
  }
}

/** Non-cryptographic stable id derived from a URL — enough to dedupe a
 *  retry of the same delivery onto the same S3 key. */
function simpleHash(input: string): string {
  let h = 5381
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 33) ^ input.charCodeAt(i)
  }
  return (h >>> 0).toString(36)
}
