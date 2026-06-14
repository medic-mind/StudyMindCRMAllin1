// Shared types + presentational helpers for the Communication Centre cockpit.
// Kept in their own module so the list shell, thread pane, and context pane can
// all import them without a circular dependency. ADR 0020. CLAUDE.md §26.

import { MailIcon, MessageSquareIcon, PhoneIcon, SmartphoneIcon } from '@/components/ui/icon'

export type InboxFilter =
  | 'active'
  | 'mine'
  | 'assigned'
  | 'unassigned'
  | 'snoozed'
  | 'closed'
  | 'mentioned'
  | 'favorites'
  | 'spam'
export type InboxChannel = 'whatsapp' | 'sms' | 'email' | 'web_chat'

export interface CockpitMe {
  id: string
  name: string | null
  role: string
}

export interface CockpitConversation {
  id: string
  trengoTicketId: number | null
  contactId: string | null
  familyId: string | null
  channel: string | null
  status: 'open' | 'closed' | 'snoozed' | 'archived' | 'spam'
  assigneeUserId: string | null
  assigneeName: string | null
  lastMessageAt: Date
  unreadCount: number
  subject: string | null
  tags: string[]
  /** First ~140 chars of the newest message — the Trengo-style row preview. */
  lastMessagePreview: string | null
  replyDeadlineAt: Date | null
  contactName: string | null
  /** Starred by the current user (Personal → Favorites). */
  isFavorite?: boolean
  /** The specific Trengo channel ("business number") name, e.g. "Support
   *  Manager". Null until synced. */
  trengoChannelName?: string | null
}

export const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  email: 'Email',
  web_chat: 'Web chat',
}

export function channelLabelFor(channel: string | null | undefined): string {
  if (channel && CHANNEL_LABEL[channel]) return CHANNEL_LABEL[channel]
  return channel ?? 'Conversation'
}

export function ChannelIcon({
  channel,
  size = 14,
}: {
  channel: string | null | undefined
  size?: number
}) {
  switch (channel) {
    case 'email':
      return <MailIcon size={size} className="text-primary-700" />
    case 'sms':
      return <SmartphoneIcon size={size} className="text-emerald-700" />
    case 'whatsapp':
      return <MessageSquareIcon size={size} className="text-emerald-700" />
    case 'web_chat':
      return <MessageSquareIcon size={size} className="text-primary-700" />
    default:
      return <PhoneIcon size={size} className="text-neutral-500" />
  }
}
