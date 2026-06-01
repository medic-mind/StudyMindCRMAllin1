// Personal saved items (ADR 0022 — pins & saves). Private per-user bookmarks
// (like Slack's "Later"/saved). Save/unsave is idempotent. The saved list spans
// every channel and is only ever visible to its owner.

import { createId } from '@paralleldrive/cuid2'

import { BusinessError } from '../errors'
import type { Db } from './ctx'
import { hydrateMessages } from './messages'
import type { ChatMessageView } from './types'

export interface SavedItem {
  savedAt: Date
  channelTitle: string
  channelKind: 'public' | 'private' | 'dm'
  message: ChatMessageView
}

function userDisplayName(u: { name: string | null; email: string } | null): string {
  if (!u) return 'Unknown'
  return (u.name ?? '').trim() || u.email
}

/** Save a message for the user. Idempotent. */
export async function saveMessage(
  db: Db,
  input: { messageId: string; userId: string },
): Promise<{ saved: true }> {
  const message = await db.chatMessage.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true },
  })
  if (!message) throw new BusinessError('MESSAGE_NOT_FOUND', 'Message not found')

  await db.chatSavedItem.upsert({
    where: { userId_messageId: { userId: input.userId, messageId: input.messageId } },
    create: { id: createId(), userId: input.userId, messageId: input.messageId },
    update: {},
  })
  return { saved: true }
}

/** Remove a saved message for the user. Idempotent. */
export async function unsaveMessage(
  db: Db,
  input: { messageId: string; userId: string },
): Promise<{ saved: false }> {
  await db.chatSavedItem.deleteMany({
    where: { userId: input.userId, messageId: input.messageId },
  })
  return { saved: false }
}

/** List the user's saved messages, newest save first, hydrated + channel-named. */
export async function listSaves(
  db: Db,
  input: { userId: string; limit?: number },
): Promise<SavedItem[]> {
  const take = Math.max(1, Math.min(input.limit ?? 50, 100))
  const saves = await db.chatSavedItem.findMany({
    where: { userId: input.userId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { messageId: true, createdAt: true },
  })
  if (saves.length === 0) return []

  const messages = await db.chatMessage.findMany({
    where: { id: { in: saves.map((s) => s.messageId) }, deletedAt: null },
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
  const views = await hydrateMessages(db, messages, input.userId)
  const viewById = new Map(views.map((v) => [v.id, v] as const))

  // Resolve channel titles (DMs → member names excluding the viewer).
  const channelIds = [...new Set(messages.map((m) => m.channelId))]
  const channels = await db.chatChannel.findMany({
    where: { id: { in: channelIds } },
    select: { id: true, name: true, kind: true },
  })
  const channelMap = new Map(channels.map((c) => [c.id, c] as const))

  const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id)
  const dmTitle = new Map<string, string>()
  if (dmIds.length > 0) {
    const dmMembers = await db.chatChannelMember.findMany({
      where: { channelId: { in: dmIds } },
      select: { channelId: true, userId: true },
    })
    const dmUsers = await db.user.findMany({
      where: { id: { in: [...new Set(dmMembers.map((m) => m.userId))] } },
      select: { id: true, name: true, email: true },
    })
    const dmNameMap = new Map(dmUsers.map((u) => [u.id, userDisplayName(u)] as const))
    const byChannel = new Map<string, string[]>()
    for (const m of dmMembers) {
      if (m.userId === input.userId) continue
      const list = byChannel.get(m.channelId) ?? []
      list.push(dmNameMap.get(m.userId) ?? 'Unknown')
      byChannel.set(m.channelId, list)
    }
    for (const [cid, names] of byChannel) dmTitle.set(cid, names.join(', '))
  }

  return saves
    .map((s) => {
      const message = viewById.get(s.messageId)
      if (!message) return null
      const channel = channelMap.get(message.channelId)
      const kind = (channel?.kind ?? 'public') as 'public' | 'private' | 'dm'
      const title =
        kind === 'dm'
          ? (dmTitle.get(message.channelId) ?? 'Direct message')
          : channel?.name
            ? `#${channel.name}`
            : 'Channel'
      return { savedAt: s.createdAt, channelTitle: title, channelKind: kind, message }
    })
    .filter((x): x is SavedItem => x != null)
}

/** Set of saved message-ids (for this user) within a batch — flags the feed. */
export async function savedMessageIds(
  db: Db,
  input: { userId: string; messageIds: ReadonlyArray<string> },
): Promise<Set<string>> {
  if (input.messageIds.length === 0) return new Set()
  const rows = await db.chatSavedItem.findMany({
    where: { userId: input.userId, messageId: { in: [...input.messageIds] } },
    select: { messageId: true },
  })
  return new Set(rows.map((r) => r.messageId))
}
