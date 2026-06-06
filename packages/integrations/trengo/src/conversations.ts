// Resolve a contact's most-recent active Trengo conversation (ticket) from the
// `message` Interactions we have already synced. Trengo writes the conversation
// id under `payload.ticketId` and the channel under `payload.channel`
// (CLAUDE.md §11).
//
// This is the single source of truth for every CRM → Trengo outbound path
// (call-summary fan-out, inbox / contact reply) so the lookup is defined once
// rather than duplicated at each call site. Pure read; the caller owns auth.

import type { PrismaClient } from '@prisma/client'

import { isTrengoChannel, type TrengoChannel } from './types'

export interface ActiveTrengoConversation {
  /** Trengo ticket (conversation) id we can post a reply onto. */
  ticketId: number
  /** Channel the conversation runs on (whatsapp | sms | email | web_chat). */
  channel: TrengoChannel
}

/** Minimal client surface so this stays unit-testable without a real DB. */
export type ConversationDb = Pick<PrismaClient, 'interaction'>

/**
 * Find the most recent Trengo conversation a contact can be replied to on.
 *
 * Scans the contact's recent `message` Interactions (newest first) and returns
 * the first that carries both a numeric `ticketId` and a recognised channel.
 * We scan a small window rather than only the single newest row so a trailing
 * lifecycle row (e.g. a label change) does not mask a replyable message.
 *
 * Returns `null` when there is nothing to reply to yet — the caller surfaces
 * that as a skip / not-found rather than an error.
 */
export async function resolveActiveTrengoConversation(
  db: ConversationDb,
  contactId: string,
  /** Optional channel filter — when set, only a conversation running on this
   *  channel is returned (used by the explicit WhatsApp / SMS senders so a
   *  WhatsApp send never lands on the contact's SMS thread, or vice-versa).
   *  Omit for "the most recent conversation on any channel". */
  channel?: TrengoChannel,
): Promise<ActiveTrengoConversation | null> {
  const rows = await db.interaction.findMany({
    where: { contactId, type: 'message', deletedAt: null },
    orderBy: { occurredAt: 'desc' },
    take: 20,
    select: { payload: true },
  })

  for (const row of rows) {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const ticketId = typeof payload['ticketId'] === 'number' ? payload['ticketId'] : null
    const channelRaw = typeof payload['channel'] === 'string' ? payload['channel'] : null
    if (ticketId !== null && channelRaw && isTrengoChannel(channelRaw)) {
      if (channel && channelRaw !== channel) continue
      return { ticketId, channel: channelRaw }
    }
  }
  return null
}
