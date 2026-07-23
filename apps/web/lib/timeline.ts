// Pure display logic for the contact Activity timeline. No React — unit
// tested in timeline.test.ts.
//
// Two jobs:
//  1. `timelineLabel` — translate an Interaction row (+ its derived meta)
//     into an honest, human label: a real Aircall call reads
//     "Inbound call · 2m 10s", a card move reads "Card moved", a quick-action
//     comment reads "Card comment" — never a bare type name, and never
//     conflating a call summary with an actual call.
//  2. `collapseTimeline` — fold runs of consecutive rows with the same type +
//     summary (e.g. seven identical "Call completed." quick-action notes
//     logged in one minute) into a single row with a ×N count, so the
//     history reads clean without deleting anything (CLAUDE.md §3).

import type { InteractionListItem } from '@studymind/core/interaction'

export type TimelineBucket =
  | 'calls'
  | 'messages'
  | 'emails'
  | 'notes'
  | 'cards'
  | 'other'

const BUCKET_FOR: Partial<Record<InteractionListItem['type'], TimelineBucket>> = {
  call: 'calls',
  call_logged: 'calls',
  'call.started': 'calls',
  'call.answered': 'calls',
  'call.ended': 'calls',
  'call.voicemail_left': 'calls',
  message: 'messages',
  'message.inbound': 'messages',
  'message.outbound': 'messages',
  ticket_assigned: 'messages',
  ticket_closed: 'messages',
  ticket_reopened: 'messages',
  label_added: 'messages',
  label_removed: 'messages',
  'ticket.assigned': 'messages',
  'ticket.closed': 'messages',
  'ticket.reopened': 'messages',
  'label.added': 'messages',
  'label.removed': 'messages',
  email_received: 'emails',
  email_sent: 'emails',
  email_forwarded: 'emails',
  note: 'notes',
  call_summary: 'notes',
  call_summary_sent: 'notes',
  task_comment: 'notes',
  card_comment: 'cards',
  card_moved: 'cards',
  card_description_changed: 'cards',
  lead_enquiry: 'other',
  booking: 'other',
  payment: 'other',
}

export function timelineBucket(type: InteractionListItem['type']): TimelineBucket {
  return BUCKET_FOR[type] ?? 'other'
}

export const TIMELINE_FILTERS: ReadonlyArray<{
  key: TimelineBucket | 'all'
  label: string
}> = [
  { key: 'all', label: 'All' },
  { key: 'calls', label: 'Calls' },
  { key: 'messages', label: 'Messages' },
  { key: 'emails', label: 'Emails' },
  { key: 'notes', label: 'Notes' },
  { key: 'cards', label: 'Cards' },
  { key: 'other', label: 'Other' },
]

export function formatDuration(durationSec: number): string {
  const m = Math.floor(durationSec / 60)
  const s = Math.round(durationSec % 60)
  if (m === 0) return `${s}s`
  return s === 0 ? `${m}m` : `${m}m ${s}s`
}

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

export interface TimelineLabel {
  /** The headline, e.g. "Inbound call · 2m 10s" or "WhatsApp message". */
  label: string
  /** Tailwind-ready tone bucket for the chip. */
  tone: 'call' | 'message' | 'email' | 'note' | 'card' | 'system'
}

export function timelineLabel(item: InteractionListItem): TimelineLabel {
  const meta = item.meta
  switch (item.type) {
    case 'call_logged':
    case 'call': {
      const dir =
        meta?.direction === 'inbound'
          ? 'Inbound call'
          : meta?.direction === 'outbound'
            ? 'Outbound call'
            : 'Call'
      const dur =
        meta?.durationSec != null && meta.durationSec > 0
          ? ` · ${formatDuration(meta.durationSec)}`
          : ''
      // Tag non-Aircall calls so the team can tell where a call came from.
      const via = meta?.source === 'google_voice' ? ' · Google Voice' : ''
      return { label: `${dir}${dur}${via}`, tone: 'call' }
    }
    case 'message': {
      const ch = meta?.channel ? (CHANNEL_LABEL[meta.channel] ?? meta.channel) : null
      const via = meta?.source === 'google_voice' ? ' · Google Voice' : ''
      return { label: `${ch ? `${ch} message` : 'Message'}${via}`, tone: 'message' }
    }
    case 'email_received':
      return { label: 'Email received', tone: 'email' }
    case 'email_sent':
      return { label: 'Email sent', tone: 'email' }
    case 'email_forwarded':
      return { label: 'Email forwarded', tone: 'email' }
    case 'note':
      return { label: 'Note', tone: 'note' }
    case 'call_summary':
      return { label: 'Call summary', tone: 'note' }
    case 'call_summary_sent':
      return { label: 'Call summary sent', tone: 'note' }
    case 'task_comment':
      return { label: 'Task comment', tone: 'note' }
    case 'card_comment':
      return { label: 'Card comment', tone: 'card' }
    case 'card_moved':
      return { label: 'Card moved', tone: 'card' }
    case 'card_description_changed':
      return { label: 'Card updated', tone: 'card' }
    case 'lead_enquiry':
      return { label: 'Web enquiry', tone: 'system' }
    case 'ticket_assigned':
      return { label: 'Conversation assigned', tone: 'message' }
    case 'ticket_closed':
      return { label: 'Conversation closed', tone: 'message' }
    case 'ticket_reopened':
      return { label: 'Conversation reopened', tone: 'message' }
    case 'label_added':
      return { label: 'Label added', tone: 'message' }
    case 'label_removed':
      return { label: 'Label removed', tone: 'message' }
    case 'booking':
      return { label: 'Booking', tone: 'system' }
    case 'payment':
      return { label: 'Payment', tone: 'system' }
    case 'family.state_changed':
      return { label: 'Pipeline stage changed', tone: 'system' }
    case 'family_pipeline_moved':
      return { label: 'Pipeline moved', tone: 'system' }
    case 'slack_summary':
      return { label: 'Slack mention', tone: 'system' }
    default: {
      // Fallback stays readable: "family.billing_contact_changed" →
      // "Family billing contact changed".
      const spaced = item.type.replace(/[._]/g, ' ')
      return {
        label: spaced.charAt(0).toUpperCase() + spaced.slice(1),
        tone: 'system',
      }
    }
  }
}

export interface CollapsedTimelineEntry {
  item: InteractionListItem
  /** How many consecutive identical rows this entry stands for (≥ 1). */
  count: number
}

/** Fold runs of consecutive rows with the same type + summary into one entry.
 *  Input order is preserved (expected newest-first). */
export function collapseTimeline(
  items: ReadonlyArray<InteractionListItem>,
): CollapsedTimelineEntry[] {
  const out: CollapsedTimelineEntry[] = []
  for (const item of items) {
    const prev = out[out.length - 1]
    if (
      prev &&
      prev.item.type === item.type &&
      (prev.item.summary ?? '') === (item.summary ?? '')
    ) {
      prev.count += 1
      continue
    }
    out.push({ item, count: 1 })
  }
  return out
}
