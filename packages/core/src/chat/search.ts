// Message search across the workspace (ADR 0022 — richer messaging). Returns
// matches only from channels the viewer can see: every channel they're a member
// of, plus all public channels. Private channels and DMs they're not in never
// surface. Newest-first, capped, with a one-line snippet for the result list.

import { bodyToPlainText } from './parse'
import type { Db } from './ctx'

export interface ChatSearchHit {
  messageId: string
  channelId: string
  channelTitle: string
  channelKind: 'public' | 'private' | 'dm'
  authorId: string
  authorName: string
  /** Plain-text snippet (tokens rendered as @Name / #Ref), trimmed for the row. */
  snippet: string
  /** Thread root when the hit is a reply, so the client can open the thread. */
  parentId: string | null
  occurredAt: Date
}

function userDisplayName(u: { name: string | null; email: string } | null): string {
  if (!u) return 'Unknown'
  return (u.name ?? '').trim() || u.email
}

/**
 * Full-text-ish search over message bodies (Prisma `contains`, case-insensitive).
 * Scoped to the viewer's visible channels. We resolve channel titles (DMs →
 * member names) and author names in batched lookups, and build a readable
 * snippet so the result row never shows raw `<@id>` tokens.
 */
export async function searchMessages(
  db: Db,
  input: { viewerId: string; query: string; limit?: number },
): Promise<ChatSearchHit[]> {
  const q = input.query.trim()
  if (q.length < 2) return []
  const take = Math.max(1, Math.min(input.limit ?? 30, 50))

  // Visible channel set: my memberships ∪ all public channels.
  const [memberships, publicChannels] = await Promise.all([
    db.chatChannelMember.findMany({
      where: { userId: input.viewerId },
      select: { channelId: true },
    }),
    db.chatChannel.findMany({
      where: { kind: 'public', archivedAt: null },
      select: { id: true },
    }),
  ])
  const visibleIds = [
    ...new Set([
      ...memberships.map((m) => m.channelId),
      ...publicChannels.map((c) => c.id),
    ]),
  ]
  if (visibleIds.length === 0) return []

  const rows = await db.chatMessage.findMany({
    where: {
      channelId: { in: visibleIds },
      deletedAt: null,
      body: { contains: q, mode: 'insensitive' },
    },
    orderBy: { createdAt: 'desc' },
    take,
    select: {
      id: true,
      channelId: true,
      authorId: true,
      body: true,
      parentId: true,
      createdAt: true,
    },
  })
  if (rows.length === 0) return []

  // Resolve channel titles + author names in two batched lookups.
  const channelIds = [...new Set(rows.map((r) => r.channelId))]
  const authorIds = [...new Set(rows.map((r) => r.authorId))]
  const [channels, authors] = await Promise.all([
    db.chatChannel.findMany({
      where: { id: { in: channelIds } },
      select: { id: true, name: true, kind: true },
    }),
    db.user.findMany({
      where: { id: { in: authorIds } },
      select: { id: true, name: true, email: true },
    }),
  ])
  const channelMap = new Map(channels.map((c) => [c.id, c] as const))
  const authorMap = new Map(authors.map((a) => [a.id, userDisplayName(a)] as const))

  // DM titles need member names (excluding the viewer).
  const dmIds = channels.filter((c) => c.kind === 'dm').map((c) => c.id)
  const dmTitle = new Map<string, string>()
  if (dmIds.length > 0) {
    const dmMembers = await db.chatChannelMember.findMany({
      where: { channelId: { in: dmIds } },
      select: { channelId: true, userId: true },
    })
    const dmUserIds = [...new Set(dmMembers.map((m) => m.userId))]
    const dmUsers = await db.user.findMany({
      where: { id: { in: dmUserIds } },
      select: { id: true, name: true, email: true },
    })
    const dmNameMap = new Map(dmUsers.map((u) => [u.id, userDisplayName(u)] as const))
    const byChannel = new Map<string, string[]>()
    for (const m of dmMembers) {
      if (m.userId === input.viewerId) continue
      const list = byChannel.get(m.channelId) ?? []
      list.push(dmNameMap.get(m.userId) ?? 'Unknown')
      byChannel.set(m.channelId, list)
    }
    for (const [cid, names] of byChannel) dmTitle.set(cid, names.join(', '))
  }

  return rows.map((r) => {
    const channel = channelMap.get(r.channelId)
    const kind = (channel?.kind ?? 'public') as 'public' | 'private' | 'dm'
    const title =
      kind === 'dm'
        ? (dmTitle.get(r.channelId) ?? 'Direct message')
        : channel?.name
          ? `#${channel.name}`
          : 'Channel'
    const plain = bodyToPlainText(r.body)
    return {
      messageId: r.id,
      channelId: r.channelId,
      channelTitle: title,
      channelKind: kind,
      authorId: r.authorId,
      authorName: authorMap.get(r.authorId) ?? 'Unknown',
      snippet: plain.length > 160 ? `${plain.slice(0, 157)}…` : plain,
      parentId: r.parentId,
      occurredAt: r.createdAt,
    }
  })
}
