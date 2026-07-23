// Chat message domain (ADR 0022): send, edit, soft-delete, threaded replies,
// @mention fan-out, emoji reactions, and read-state. Bodies are stored verbatim
// (with <@id> / <~type:id> tokens — see parse.ts); mentions and refs are also
// extracted into their own tables so "my mentions" and "messages referencing
// this customer" are single index hits.
//
// These writes are deliberately NOT mirrored into the customer Interaction
// timeline or the compliance AuditLog: this is high-volume staff↔staff chat,
// not a customer-facing or compliance event (CLAUDE.md §45.2 — a name only
// lands in those streams when it has timeline/compliance value).

import { createId } from '@paralleldrive/cuid2'

import { BusinessError } from '../errors'
import type { Db } from './ctx'
import { extractMentionUserIds, extractRefs } from './parse'
import { resolveRefs } from './refs'
import type {
  ChatAttachmentView,
  ChatMessageView,
  ChatReactionView,
  ChatRefView,
} from './types'

const MAX_BODY = 8000

function userDisplayName(u: { name: string | null; email: string } | null): string {
  if (!u) return 'Unknown'
  return (u.name ?? '').trim() || u.email
}

async function requireOpenChannel(db: Db, channelId: string): Promise<{ kind: string }> {
  const channel = await db.chatChannel.findUnique({
    where: { id: channelId },
    select: { id: true, archivedAt: true, kind: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')
  if (channel.archivedAt) throw new BusinessError('CHANNEL_ARCHIVED', 'Channel is archived')
  return { kind: channel.kind }
}

/**
 * Post a message into a channel (top-level) or a thread (when parentId is set).
 * Extracts @mentions and entity refs, persists them, bumps the parent thread's
 * reply counters, and returns the rendered message view-model.
 */
export interface StagedAttachment {
  /** Pre-minted id (also the S3 key segment). */
  id: string
  filename: string
  contentType: string
  sizeBytes: number
  s3Key: string
  width?: number | null
  height?: number | null
}

export async function sendMessage(
  db: Db,
  input: {
    channelId: string
    authorId: string
    body: string
    parentId?: string | null
    attachments?: ReadonlyArray<StagedAttachment>
  },
): Promise<ChatMessageView> {
  const body = input.body.trim()
  const attachments = input.attachments ?? []
  // A message must carry text OR at least one attachment (Slack-style — you can
  // post an image with no caption).
  if (body.length === 0 && attachments.length === 0) {
    throw new BusinessError('MESSAGE_EMPTY', 'Type a message or attach a file')
  }
  if (body.length > MAX_BODY) throw new BusinessError('MESSAGE_EMPTY', 'Message is too long')

  const channel = await requireOpenChannel(db, input.channelId)

  let parentId: string | null = null
  if (input.parentId) {
    const parent = await db.chatMessage.findFirst({
      where: { id: input.parentId, channelId: input.channelId, deletedAt: null },
      select: { id: true, parentId: true },
    })
    if (!parent) throw new BusinessError('MESSAGE_NOT_FOUND', 'Thread not found')
    // Two-level threading: a reply always attaches to the ROOT, never to
    // another reply (Slack semantics).
    parentId = parent.parentId ?? parent.id
  }

  const id = createId()
  const now = new Date()
  const mentionIds = extractMentionUserIds(body)
  const refs = extractRefs(body)

  // A private channel / DM must not notify (nor leak content to) a non-member.
  // Public channels are open to all staff and auto-join on post, so a mentioned
  // teammate legitimately has no membership row yet — never filter those.
  let effectiveMentionIds = mentionIds
  if (mentionIds.length > 0 && channel.kind !== 'public') {
    const members = await db.chatChannelMember.findMany({
      where: { channelId: input.channelId, userId: { in: mentionIds } },
      select: { userId: true },
    })
    const memberSet = new Set(members.map((m) => m.userId))
    effectiveMentionIds = mentionIds.filter((u) => memberSet.has(u))
  }

  await db.chatMessage.create({
    data: {
      id,
      channelId: input.channelId,
      authorId: input.authorId,
      body,
      parentId,
      createdAt: now,
      ...(effectiveMentionIds.length > 0
        ? {
            mentions: {
              create: effectiveMentionIds.map((userId) => ({
                id: createId(),
                userId,
                channelId: input.channelId,
              })),
            },
          }
        : {}),
      ...(refs.length > 0
        ? {
            refs: {
              create: refs.map((r) => ({ id: createId(), refType: r.type, refId: r.id })),
            },
          }
        : {}),
      ...(attachments.length > 0
        ? {
            attachments: {
              create: attachments.map((a) => ({
                id: a.id,
                filename: a.filename,
                contentType: a.contentType,
                sizeBytes: a.sizeBytes,
                s3Key: a.s3Key,
                width: a.width ?? null,
                height: a.height ?? null,
                createdById: input.authorId,
              })),
            },
          }
        : {}),
    },
  })

  // Bump thread counters on the root message so the channel can show "N
  // replies" without counting children every render.
  if (parentId) {
    await db.chatMessage.update({
      where: { id: parentId },
      data: { replyCount: { increment: 1 }, lastReplyAt: now },
    })
  }

  // Author's own read marker advances to now (you've "read" what you sent).
  await db.chatChannelMember.updateMany({
    where: { channelId: input.channelId, userId: input.authorId },
    data: { lastReadAt: now },
  })

  const author = await db.user.findUnique({
    where: { id: input.authorId },
    select: { id: true, name: true, email: true },
  })
  const refViews = await resolveRefs(db, refs)

  return {
    id,
    channelId: input.channelId,
    authorId: input.authorId,
    authorName: userDisplayName(author),
    body,
    parentId,
    replyCount: 0,
    lastReplyAt: null,
    editedAt: null,
    deletedAt: null,
    createdAt: now,
    mentionUserIds: effectiveMentionIds,
    refs: refs
      .map((r) => refViews.get(`${r.type}:${r.id}`))
      .filter((x): x is ChatRefView => x != null),
    reactions: [],
    replyAuthorNames: [],
    attachments: attachments.map((a) => ({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      width: a.width ?? null,
      height: a.height ?? null,
      isImage: /^image\//i.test(a.contentType),
      url: `/api/internal/chat-attachments/${a.id}`,
    })),
    // A freshly-sent message is never pinned or saved yet.
    pinned: false,
    saved: false,
  }
}

/**
 * Edit a message's body (author only — enforced at the tRPC layer). Re-extracts
 * mentions and refs so newly-added @mentions notify and removed ones stop.
 */
export async function editMessage(
  db: Db,
  input: { id: string; authorId: string; body: string },
): Promise<{ id: string; body: string; editedAt: Date }> {
  const body = input.body.trim()
  if (body.length === 0) throw new BusinessError('MESSAGE_EMPTY', 'Message cannot be empty')

  const message = await db.chatMessage.findFirst({
    where: { id: input.id, deletedAt: null },
    select: { id: true, authorId: true, channelId: true },
  })
  if (!message) throw new BusinessError('MESSAGE_NOT_FOUND', 'Message not found')
  if (message.authorId !== input.authorId) {
    throw new BusinessError('CHAT_FORBIDDEN', 'You can only edit your own messages')
  }

  const editedAt = new Date()
  const mentionIds = extractMentionUserIds(body)
  const refs = extractRefs(body)

  // Set-diff the mentions so UNCHANGED @mentions keep their row (and its
  // readAt). Deleting + recreating every mention reset read-state on all of
  // them and re-notified recipients on any edit. Only remove mentions that are
  // gone and add ones that are new. Refs carry no read-state, so replace them.
  const existingMentions = await db.chatMention.findMany({
    where: { messageId: input.id },
    select: { userId: true },
  })
  const existingIds = new Set(existingMentions.map((m) => m.userId))
  const newIds = new Set(mentionIds)
  const toRemove = [...existingIds].filter((u) => !newIds.has(u))
  let toAdd = mentionIds.filter((u) => !existingIds.has(u))
  // Same private-channel/DM guard as sendMessage: a newly-added @mention must
  // not reach a non-member. Public channels never filter.
  if (toAdd.length > 0) {
    const channel = await db.chatChannel.findUnique({
      where: { id: message.channelId },
      select: { kind: true },
    })
    if (channel && channel.kind !== 'public') {
      const members = await db.chatChannelMember.findMany({
        where: { channelId: message.channelId, userId: { in: toAdd } },
        select: { userId: true },
      })
      const memberSet = new Set(members.map((m) => m.userId))
      toAdd = toAdd.filter((u) => memberSet.has(u))
    }
  }
  if (toRemove.length > 0) {
    await db.chatMention.deleteMany({
      where: { messageId: input.id, userId: { in: toRemove } },
    })
  }
  await db.chatMessageRef.deleteMany({ where: { messageId: input.id } })

  await db.chatMessage.update({
    where: { id: input.id },
    data: {
      body,
      editedAt,
      ...(toAdd.length > 0
        ? {
            mentions: {
              create: toAdd.map((userId) => ({
                id: createId(),
                userId,
                channelId: message.channelId,
              })),
            },
          }
        : {}),
      ...(refs.length > 0
        ? {
            refs: {
              create: refs.map((r) => ({ id: createId(), refType: r.type, refId: r.id })),
            },
          }
        : {}),
    },
  })

  return { id: input.id, body, editedAt }
}

/**
 * Soft-delete a message. Author can delete their own; channel admins / Manager+
 * can delete any (enforced at the tRPC layer via `allowAny`). Decrements the
 * parent thread counter when a reply is removed.
 */
export async function deleteMessage(
  db: Db,
  input: { id: string; actorId: string; allowAny?: boolean },
): Promise<{ id: string }> {
  const message = await db.chatMessage.findFirst({
    where: { id: input.id, deletedAt: null },
    select: { id: true, authorId: true, parentId: true },
  })
  if (!message) throw new BusinessError('MESSAGE_NOT_FOUND', 'Message not found')
  if (!input.allowAny && message.authorId !== input.actorId) {
    throw new BusinessError('CHAT_FORBIDDEN', 'You can only delete your own messages')
  }

  await db.chatMessage.update({
    where: { id: input.id },
    data: { deletedAt: new Date(), body: '' },
  })
  // Drop the mention rows so a deleted message stops showing in mention inboxes.
  await db.chatMention.deleteMany({ where: { messageId: input.id } })

  if (message.parentId) {
    await db.chatMessage.update({
      where: { id: message.parentId },
      data: { replyCount: { decrement: 1 } },
    })
  }
  return { id: input.id }
}

/** Toggle a reaction: add if absent, remove if the actor already reacted. */
export async function toggleReaction(
  db: Db,
  input: { messageId: string; userId: string; emoji: string },
): Promise<{ reacted: boolean }> {
  const message = await db.chatMessage.findFirst({
    where: { id: input.messageId, deletedAt: null },
    select: { id: true },
  })
  if (!message) throw new BusinessError('MESSAGE_NOT_FOUND', 'Message not found')

  const existing = await db.chatReaction.findUnique({
    where: {
      messageId_userId_emoji: {
        messageId: input.messageId,
        userId: input.userId,
        emoji: input.emoji,
      },
    },
    select: { id: true },
  })
  if (existing) {
    await db.chatReaction.delete({ where: { id: existing.id } })
    return { reacted: false }
  }
  await db.chatReaction.create({
    data: {
      id: createId(),
      messageId: input.messageId,
      userId: input.userId,
      emoji: input.emoji,
    },
  })
  return { reacted: true }
}

interface RawMessage {
  id: string
  channelId: string
  authorId: string
  body: string
  parentId: string | null
  replyCount: number
  lastReplyAt: Date | null
  editedAt: Date | null
  deletedAt: Date | null
  createdAt: Date
}

/**
 * Hydrate a batch of raw message rows into view-models: author names, reaction
 * rollups (with the viewer's own reactions flagged), resolved entity-ref chips,
 * and thread reply-author previews. Batched so a 50-message page costs a small
 * constant number of queries.
 */
export async function hydrateMessages(
  db: Db,
  rows: ReadonlyArray<RawMessage>,
  viewerId: string,
): Promise<ChatMessageView[]> {
  if (rows.length === 0) return []
  const messageIds = rows.map((r) => r.id)
  const rootIds = rows.filter((r) => r.replyCount > 0).map((r) => r.id)

  const [reactions, refRows, authorRows, replyPreviewRows, attachmentRows, pinRows, saveRows] =
    await Promise.all([
      db.chatReaction.findMany({
        where: { messageId: { in: messageIds } },
        select: { messageId: true, userId: true, emoji: true },
      }),
      db.chatMessageRef.findMany({
        where: { messageId: { in: messageIds } },
        select: { messageId: true, refType: true, refId: true },
      }),
      db.user.findMany({
        where: { id: { in: [...new Set(rows.map((r) => r.authorId))] } },
        select: { id: true, name: true, email: true },
      }),
      rootIds.length > 0
        ? db.chatMessage.findMany({
            where: { parentId: { in: rootIds }, deletedAt: null },
            orderBy: { createdAt: 'desc' },
            select: { parentId: true, authorId: true },
          })
        : Promise.resolve([] as { parentId: string | null; authorId: string }[]),
      db.chatAttachment.findMany({
        where: { messageId: { in: messageIds } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          messageId: true,
          filename: true,
          contentType: true,
          sizeBytes: true,
          width: true,
          height: true,
        },
      }),
      db.chatPin.findMany({
        where: { messageId: { in: messageIds } },
        select: { messageId: true },
      }),
      db.chatSavedItem.findMany({
        where: { userId: viewerId, messageId: { in: messageIds } },
        select: { messageId: true },
      }),
    ])

  const pinnedSet = new Set(pinRows.map((p) => p.messageId))
  const savedSet = new Set(saveRows.map((s) => s.messageId))

  // Collect reactor + reply-author ids so we resolve every needed name once.
  const nameIds = new Set<string>()
  for (const a of authorRows) nameIds.add(a.id)
  for (const r of reactions) nameIds.add(r.userId)
  for (const r of replyPreviewRows) nameIds.add(r.authorId)
  const nameMap = await loadNameMap(db, authorRows, [...nameIds])

  // Resolve all entity refs across the page in one batched call.
  const allRefs = refRows.map((r) => ({ type: r.refType, id: r.refId }))
  const refViewMap = await resolveRefs(db, allRefs)

  // Group reactions per message → per emoji.
  const reactionsByMessage = new Map<string, Map<string, { count: number; mine: boolean; names: string[] }>>()
  for (const r of reactions) {
    const perMsg = reactionsByMessage.get(r.messageId) ?? new Map()
    const cur = perMsg.get(r.emoji) ?? { count: 0, mine: false, names: [] }
    cur.count += 1
    if (r.userId === viewerId) cur.mine = true
    cur.names.push(nameMap.get(r.userId) ?? 'Someone')
    perMsg.set(r.emoji, cur)
    reactionsByMessage.set(r.messageId, perMsg)
  }

  const refsByMessage = new Map<string, ChatRefView[]>()
  for (const r of refRows) {
    const view = refViewMap.get(`${r.refType}:${r.refId}`)
    if (!view) continue
    const list = refsByMessage.get(r.messageId) ?? []
    list.push(view)
    refsByMessage.set(r.messageId, list)
  }

  const replyAuthorsByRoot = new Map<string, string[]>()
  for (const r of replyPreviewRows) {
    if (!r.parentId) continue
    const list = replyAuthorsByRoot.get(r.parentId) ?? []
    const name = nameMap.get(r.authorId) ?? 'Someone'
    if (!list.includes(name) && list.length < 3) list.push(name)
    replyAuthorsByRoot.set(r.parentId, list)
  }

  // Group attachments per message into their view-models (proxy download URL,
  // image flag for inline rendering).
  const attachmentsByMessage = new Map<string, ChatAttachmentView[]>()
  for (const a of attachmentRows) {
    const list = attachmentsByMessage.get(a.messageId) ?? []
    list.push({
      id: a.id,
      filename: a.filename,
      contentType: a.contentType,
      sizeBytes: a.sizeBytes,
      width: a.width,
      height: a.height,
      isImage: /^image\//i.test(a.contentType),
      url: `/api/internal/chat-attachments/${a.id}`,
    })
    attachmentsByMessage.set(a.messageId, list)
  }

  // Body re-parse gives the ordered token list for the client; we only need the
  // mention ids here (the renderer re-tokenises with parse.ts on its side).
  return rows.map((row) => {
    const reactionMap = reactionsByMessage.get(row.id)
    const reactionViews: ChatReactionView[] = reactionMap
      ? [...reactionMap.entries()].map(([emoji, v]) => ({
          emoji,
          count: v.count,
          mine: v.mine,
          names: v.names,
        }))
      : []
    return {
      id: row.id,
      channelId: row.channelId,
      authorId: row.authorId,
      authorName: nameMap.get(row.authorId) ?? 'Unknown',
      body: row.deletedAt ? '' : row.body,
      parentId: row.parentId,
      replyCount: row.replyCount,
      lastReplyAt: row.lastReplyAt,
      editedAt: row.editedAt,
      deletedAt: row.deletedAt,
      createdAt: row.createdAt,
      mentionUserIds: row.deletedAt ? [] : extractMentionUserIds(row.body),
      refs: row.deletedAt ? [] : (refsByMessage.get(row.id) ?? []),
      reactions: reactionViews,
      replyAuthorNames: replyAuthorsByRoot.get(row.id) ?? [],
      attachments: row.deletedAt ? [] : (attachmentsByMessage.get(row.id) ?? []),
      pinned: pinnedSet.has(row.id),
      saved: savedSet.has(row.id),
    }
  })
}

async function loadNameMap(
  db: Db,
  known: ReadonlyArray<{ id: string; name: string | null; email: string }>,
  allIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  for (const u of known) map.set(u.id, userDisplayName(u))
  const missing = allIds.filter((id) => !map.has(id))
  if (missing.length > 0) {
    const rows = await db.user.findMany({
      where: { id: { in: missing } },
      select: { id: true, name: true, email: true },
    })
    for (const u of rows) map.set(u.id, userDisplayName(u))
  }
  return map
}
