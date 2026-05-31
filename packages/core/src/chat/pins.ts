// Channel pins (ADR 0022 — pins & saves). Shared, channel-scoped: any channel
// member can pin or unpin a message; everyone sees the same Pins tab. Pin/unpin
// is idempotent. Listing returns hydrated message view-models (newest pin
// first) plus who pinned each.

import { createId } from '@paralleldrive/cuid2'

import { BusinessError } from '../errors'
import type { Db } from './ctx'
import { hydrateMessages } from './messages'
import type { ChatMessageView } from './types'

export interface PinnedMessage {
  pinnedById: string
  pinnedByName: string
  pinnedAt: Date
  message: ChatMessageView
}

function userDisplayName(u: { name: string | null; email: string } | null): string {
  if (!u) return 'Unknown'
  return (u.name ?? '').trim() || u.email
}

/** Pin a message to its channel. Idempotent — re-pinning is a no-op. */
export async function pinMessage(
  db: Db,
  input: { messageId: string; userId: string },
): Promise<{ pinned: true }> {
  const message = await db.chatMessage.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true, channelId: true },
  })
  if (!message) throw new BusinessError('MESSAGE_NOT_FOUND', 'Message not found')

  await db.chatPin.upsert({
    where: { messageId: input.messageId },
    create: {
      id: createId(),
      messageId: input.messageId,
      channelId: message.channelId,
      pinnedById: input.userId,
    },
    update: {},
  })
  return { pinned: true }
}

/** Remove a message's pin. Idempotent. */
export async function unpinMessage(
  db: Db,
  input: { messageId: string },
): Promise<{ pinned: false }> {
  await db.chatPin.deleteMany({ where: { messageId: input.messageId } })
  return { pinned: false }
}

/** List a channel's pinned messages, newest pin first, hydrated for display. */
export async function listPins(
  db: Db,
  input: { channelId: string; viewerId: string },
): Promise<PinnedMessage[]> {
  const pins = await db.chatPin.findMany({
    where: { channelId: input.channelId },
    orderBy: { createdAt: 'desc' },
    select: { messageId: true, pinnedById: true, createdAt: true },
  })
  if (pins.length === 0) return []

  const messages = await db.chatMessage.findMany({
    where: { id: { in: pins.map((p) => p.messageId) }, deletedAt: null },
    select: {
      id: true,
      channelId: true,
      authorId: true,
      body: true,
      parentId: true,
      replyCount: true,
      lastReplyAt: true,
      editedAt: true,
      deletedAt: true,
      createdAt: true,
    },
  })
  const views = await hydrateMessages(db, messages, input.viewerId)
  const viewById = new Map(views.map((v) => [v.id, v] as const))

  const pinnerIds = [...new Set(pins.map((p) => p.pinnedById))]
  const pinners = await db.user.findMany({
    where: { id: { in: pinnerIds } },
    select: { id: true, name: true, email: true },
  })
  const pinnerMap = new Map(pinners.map((u) => [u.id, userDisplayName(u)] as const))

  return pins
    .map((p) => {
      const message = viewById.get(p.messageId)
      if (!message) return null
      return {
        pinnedById: p.pinnedById,
        pinnedByName: pinnerMap.get(p.pinnedById) ?? 'Unknown',
        pinnedAt: p.createdAt,
        message,
      }
    })
    .filter((x): x is PinnedMessage => x != null)
}

/** Set of pinned message-ids within a batch — used to flag the channel feed. */
export async function pinnedMessageIds(
  db: Db,
  messageIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set()
  const rows = await db.chatPin.findMany({
    where: { messageId: { in: [...messageIds] } },
    select: { messageId: true },
  })
  return new Set(rows.map((r) => r.messageId))
}
