// Chat read-state (ADR 0022): per-member unread + mention counts, the global
// unread badge for the top bar, and the "mark read" write. Read markers live on
// ChatChannelMember.lastReadAt; mention read-state lives on ChatMention.readAt
// so the two badges (channel unread vs. @mentions) move independently — exactly
// like Slack.

import type { Db } from './ctx'

export interface ChannelReadCounts {
  unreadCount: number
  mentionCount: number
  lastMessageAt: Date | null
}

/**
 * Unread + mention counts for one member in one channel. Unread = messages
 * authored by someone else after the member's lastReadAt. Mentions = unread
 * ChatMention rows for the member in this channel.
 */
export async function channelReadCounts(
  db: Db,
  input: { channelId: string; userId: string; lastReadAt: Date | null },
): Promise<ChannelReadCounts> {
  const [unreadCount, mentionCount, latest] = await Promise.all([
    db.chatMessage.count({
      where: {
        channelId: input.channelId,
        deletedAt: null,
        authorId: { not: input.userId },
        ...(input.lastReadAt ? { createdAt: { gt: input.lastReadAt } } : {}),
      },
    }),
    db.chatMention.count({
      where: { channelId: input.channelId, userId: input.userId, readAt: null },
    }),
    db.chatMessage.findFirst({
      where: { channelId: input.channelId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])
  return { unreadCount, mentionCount, lastMessageAt: latest?.createdAt ?? null }
}

/**
 * Mark a channel read up to `at` (default now): advance the member's lastReadAt
 * and clear their unread mentions in that channel. Idempotent.
 */
export async function markChannelRead(
  db: Db,
  input: { channelId: string; userId: string; at?: Date },
): Promise<{ ok: true }> {
  const at = input.at ?? new Date()
  await db.chatChannelMember.updateMany({
    where: { channelId: input.channelId, userId: input.userId },
    data: { lastReadAt: at },
  })
  await db.chatMention.updateMany({
    where: { channelId: input.channelId, userId: input.userId, readAt: null },
    data: { readAt: at },
  })
  return { ok: true }
}

/**
 * Workspace-wide unread totals for the top-bar chat badge: total unread
 * messages across the member's non-muted channels, and total unread @mentions.
 * The mention count is the one we surface as a red badge; unread is the muted
 * grey count.
 */
export async function workspaceUnread(
  db: Db,
  input: { userId: string },
): Promise<{ unreadCount: number; mentionCount: number }> {
  const memberships = await db.chatChannelMember.findMany({
    where: { userId: input.userId, mutedAt: null },
    select: { channelId: true, lastReadAt: true },
  })

  let unreadCount = 0
  for (const m of memberships) {
    unreadCount += await db.chatMessage.count({
      where: {
        channelId: m.channelId,
        deletedAt: null,
        authorId: { not: input.userId },
        ...(m.lastReadAt ? { createdAt: { gt: m.lastReadAt } } : {}),
      },
    })
  }

  const mentionCount = await db.chatMention.count({
    where: { userId: input.userId, readAt: null },
  })

  return { unreadCount, mentionCount }
}
