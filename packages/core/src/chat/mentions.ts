// Mentions inbox (ADR 0022): the "@you" feed across every channel, like
// Slack's Mentions & reactions view. Drives both the dedicated inbox page and
// the unread-mention badge on the chat nav.

import type { Db } from './ctx'
import { resolveRefs } from './refs'
import type { ChatRefView } from './types'

export interface MentionInboxItem {
  mentionId: string
  messageId: string
  channelId: string
  channelTitle: string
  authorId: string
  authorName: string
  body: string
  refs: ChatRefView[]
  read: boolean
  occurredAt: Date
}

function userDisplayName(u: { name: string | null; email: string } | null): string {
  if (!u) return 'Unknown'
  return (u.name ?? '').trim() || u.email
}

/**
 * List the most recent @mentions of `userId` across all channels, newest first.
 * `onlyUnread` restricts to the unread feed. Resolves author names, channel
 * titles (DMs render their members), and any entity-ref chips on each message.
 */
export async function listMentions(
  db: Db,
  input: { userId: string; onlyUnread?: boolean; limit?: number },
): Promise<MentionInboxItem[]> {
  const take = Math.max(1, Math.min(input.limit ?? 30, 100))
  const mentions = await db.chatMention.findMany({
    where: { userId: input.userId, ...(input.onlyUnread ? { readAt: null } : {}) },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, messageId: true, channelId: true, readAt: true, createdAt: true },
  })
  if (mentions.length === 0) return []

  const messageIds = mentions.map((m) => m.messageId)
  const channelIds = [...new Set(mentions.map((m) => m.channelId))]

  const [messages, channels] = await Promise.all([
    db.chatMessage.findMany({
      where: { id: { in: messageIds } },
      select: { id: true, authorId: true, body: true, deletedAt: true },
    }),
    db.chatChannel.findMany({
      where: { id: { in: channelIds } },
      select: { id: true, name: true, kind: true },
    }),
  ])
  const messageMap = new Map(messages.map((m) => [m.id, m] as const))
  const channelMap = new Map(channels.map((c) => [c.id, c] as const))

  // Resolve channel titles: named channels use #name; DMs use member names.
  const dmChannelIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id)
  const dmTitleMap = new Map<string, string>()
  if (dmChannelIds.length > 0) {
    const dmMembers = await db.chatChannelMember.findMany({
      where: { channelId: { in: dmChannelIds } },
      select: { channelId: true, userId: true },
    })
    const memberUserIds = [...new Set(dmMembers.map((m) => m.userId))]
    const memberUsers = await db.user.findMany({
      where: { id: { in: memberUserIds } },
      select: { id: true, name: true, email: true },
    })
    const memberNameMap = new Map(memberUsers.map((u) => [u.id, userDisplayName(u)] as const))
    const byChannel = new Map<string, string[]>()
    for (const m of dmMembers) {
      if (m.userId === input.userId) continue
      const list = byChannel.get(m.channelId) ?? []
      list.push(memberNameMap.get(m.userId) ?? 'Unknown')
      byChannel.set(m.channelId, list)
    }
    for (const [channelId, names] of byChannel) {
      dmTitleMap.set(channelId, names.join(', '))
    }
  }

  // Author names + entity refs across the whole batch.
  const authorIds = [...new Set(messages.map((m) => m.authorId))]
  const authors = await db.user.findMany({
    where: { id: { in: authorIds } },
    select: { id: true, name: true, email: true },
  })
  const authorMap = new Map(authors.map((a) => [a.id, userDisplayName(a)] as const))

  const refRows = await db.chatMessageRef.findMany({
    where: { messageId: { in: messageIds } },
    select: { messageId: true, refType: true, refId: true },
  })
  const refViewMap = await resolveRefs(
    db,
    refRows.map((r) => ({ type: r.refType, id: r.refId })),
  )
  const refsByMessage = new Map<string, ChatRefView[]>()
  for (const r of refRows) {
    const view = refViewMap.get(`${r.refType}:${r.refId}`)
    if (!view) continue
    const list = refsByMessage.get(r.messageId) ?? []
    list.push(view)
    refsByMessage.set(r.messageId, list)
  }

  return mentions
    .map((mention) => {
      const message = messageMap.get(mention.messageId)
      if (!message || message.deletedAt) return null
      const channel = channelMap.get(mention.channelId)
      const title =
        channel?.kind === 'dm'
          ? (dmTitleMap.get(mention.channelId) ?? 'Direct message')
          : channel?.name
            ? `#${channel.name}`
            : 'Channel'
      return {
        mentionId: mention.id,
        messageId: mention.messageId,
        channelId: mention.channelId,
        channelTitle: title,
        authorId: message.authorId,
        authorName: authorMap.get(message.authorId) ?? 'Unknown',
        body: message.body,
        refs: refsByMessage.get(mention.messageId) ?? [],
        read: mention.readAt != null,
        occurredAt: mention.createdAt,
      }
    })
    .filter((x): x is MentionInboxItem => x != null)
}

/** Mark a single mention read (clicking it in the inbox). */
export async function markMentionRead(
  db: Db,
  input: { mentionId: string; userId: string },
): Promise<{ ok: true }> {
  await db.chatMention.updateMany({
    where: { id: input.mentionId, userId: input.userId, readAt: null },
    data: { readAt: new Date() },
  })
  return { ok: true }
}

/** Mark every mention read (the "mark all read" action). */
export async function markAllMentionsRead(
  db: Db,
  input: { userId: string },
): Promise<{ ok: true }> {
  await db.chatMention.updateMany({
    where: { userId: input.userId, readAt: null },
    data: { readAt: new Date() },
  })
  return { ok: true }
}
