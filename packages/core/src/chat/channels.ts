// Chat channel + membership domain (ADR 0022). Channel administration
// (create / rename / archive / membership) is audited at the tRPC layer; this
// module owns the data writes and the view-model shaping. DMs are created
// implicitly via `openDm` and deduped on a sorted member key.

import { createId } from '@paralleldrive/cuid2'

import { BusinessError } from '../errors'
import type { ActorCtx, Db } from './ctx'
import type {
  ChatChannelView,
  ChatNotifyLevel,
  ChatUserLite,
  CreateChannelInput,
  UpdateChannelInput,
} from './types'

/** Normalise a free-text channel name to a lower-kebab slug. */
export function slugifyChannelName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60)
}

/** Stable dedupe key for a DM: sorted member ids joined by ':'. */
export function dmKeyFor(userIds: ReadonlyArray<string>): string {
  return [...new Set(userIds)].sort().join(':')
}

function userDisplayName(u: { name: string | null; email: string }): string {
  return (u.name ?? '').trim() || u.email
}

async function loadUsers(db: Db, ids: ReadonlyArray<string>): Promise<Map<string, ChatUserLite>> {
  const unique = [...new Set(ids)].filter((x) => x.length > 0)
  if (unique.length === 0) return new Map()
  const rows = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  })
  return new Map(
    rows.map((u) => [u.id, { id: u.id, name: userDisplayName(u), email: u.email }] as const),
  )
}

/**
 * Create a public or private channel. The creator is added as an admin member;
 * any supplied memberIds (deduped, creator-excluded) join as members. Names are
 * slugified and must be unique among non-archived channels.
 */
export async function createChannel(
  db: Db,
  input: CreateChannelInput,
  ctx: ActorCtx,
): Promise<{ id: string; name: string }> {
  const name = slugifyChannelName(input.name)
  if (name.length === 0) {
    throw new BusinessError('CHANNEL_NAME_TAKEN', 'Give the channel a valid name')
  }
  const clash = await db.chatChannel.findFirst({
    where: { name, archivedAt: null },
    select: { id: true },
  })
  if (clash) {
    throw new BusinessError('CHANNEL_NAME_TAKEN', `#${name} already exists`)
  }

  const id = createId()
  const memberIds = new Set<string>(input.memberIds ?? [])
  memberIds.delete(ctx.actorId)

  await db.chatChannel.create({
    data: {
      id,
      name,
      kind: input.kind,
      topic: input.topic ?? null,
      description: input.description ?? null,
      createdById: ctx.actorId,
      updatedById: ctx.actorId,
      members: {
        create: [
          { id: createId(), userId: ctx.actorId, role: 'admin', lastReadAt: new Date() },
          ...[...memberIds].map((userId) => ({ id: createId(), userId, role: 'member' })),
        ],
      },
    },
  })

  return { id, name }
}

/** Rename / re-topic a channel. Slug uniqueness enforced on rename. */
export async function updateChannel(
  db: Db,
  input: UpdateChannelInput,
  _ctx: ActorCtx,
): Promise<{ id: string }> {
  const channel = await db.chatChannel.findUnique({
    where: { id: input.id },
    select: { id: true, isGeneral: true, archivedAt: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')
  if (channel.archivedAt) throw new BusinessError('CHANNEL_ARCHIVED', 'Channel is archived')

  let nextName: string | undefined
  if (input.name !== undefined) {
    if (channel.isGeneral) {
      throw new BusinessError('CHANNEL_IS_GENERAL', 'The #general channel cannot be renamed')
    }
    nextName = slugifyChannelName(input.name)
    const clash = await db.chatChannel.findFirst({
      where: { name: nextName, archivedAt: null, id: { not: input.id } },
      select: { id: true },
    })
    if (clash) throw new BusinessError('CHANNEL_NAME_TAKEN', `#${nextName} already exists`)
  }

  await db.chatChannel.update({
    where: { id: input.id },
    data: {
      ...(nextName !== undefined ? { name: nextName } : {}),
      ...(input.topic !== undefined ? { topic: input.topic } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      updatedById: _ctx.actorId,
    },
  })
  return { id: input.id }
}

export async function archiveChannel(
  db: Db,
  input: { id: string },
  ctx: ActorCtx,
): Promise<{ id: string }> {
  const channel = await db.chatChannel.findUnique({
    where: { id: input.id },
    select: { id: true, isGeneral: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')
  if (channel.isGeneral) {
    throw new BusinessError('CHANNEL_IS_GENERAL', 'The #general channel cannot be archived')
  }
  await db.chatChannel.update({
    where: { id: input.id },
    data: { archivedAt: new Date(), updatedById: ctx.actorId },
  })
  return { id: input.id }
}

export async function restoreChannel(
  db: Db,
  input: { id: string },
  ctx: ActorCtx,
): Promise<{ id: string }> {
  const channel = await db.chatChannel.findUnique({
    where: { id: input.id },
    select: { id: true, name: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')
  if (channel.name) {
    const clash = await db.chatChannel.findFirst({
      where: { name: channel.name, archivedAt: null, id: { not: input.id } },
      select: { id: true },
    })
    if (clash) throw new BusinessError('CHANNEL_NAME_TAKEN', `#${channel.name} already exists`)
  }
  await db.chatChannel.update({
    where: { id: input.id },
    data: { archivedAt: null, updatedById: ctx.actorId },
  })
  return { id: input.id }
}

/**
 * Ensure the actor is a member of the channel. Public channels auto-join on
 * first open (Slack-style); private channels and DMs require an existing
 * membership row. Returns the membership row id. Idempotent.
 */
export async function ensureMembership(
  db: Db,
  input: { channelId: string; userId: string },
): Promise<string> {
  const channel = await db.chatChannel.findUnique({
    where: { id: input.channelId },
    select: { id: true, kind: true, archivedAt: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')

  const existing = await db.chatChannelMember.findUnique({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    select: { id: true },
  })
  if (existing) return existing.id

  if (channel.kind !== 'public') {
    throw new BusinessError('NOT_CHANNEL_MEMBER', 'You are not a member of this channel')
  }
  if (channel.archivedAt) {
    throw new BusinessError('CHANNEL_ARCHIVED', 'Channel is archived')
  }
  const id = createId()
  await db.chatChannelMember.create({
    data: { id, channelId: input.channelId, userId: input.userId, role: 'member' },
  })
  return id
}

/** Add a member to a channel (explicit invite). Idempotent. */
export async function addMember(
  db: Db,
  input: { channelId: string; userId: string },
  _ctx: ActorCtx,
): Promise<{ id: string }> {
  const channel = await db.chatChannel.findUnique({
    where: { id: input.channelId },
    select: { id: true, archivedAt: true },
  })
  if (!channel) throw new BusinessError('CHANNEL_NOT_FOUND', 'Channel not found')
  if (channel.archivedAt) throw new BusinessError('CHANNEL_ARCHIVED', 'Channel is archived')

  const id = createId()
  const member = await db.chatChannelMember.upsert({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    create: { id, channelId: input.channelId, userId: input.userId, role: 'member' },
    update: {},
    select: { id: true },
  })
  return { id: member.id }
}

/** Remove a member from a channel (or self-leave). */
export async function removeMember(
  db: Db,
  input: { channelId: string; userId: string },
  _ctx: ActorCtx,
): Promise<{ removed: boolean }> {
  const member = await db.chatChannelMember.findUnique({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    select: { id: true },
  })
  if (!member) return { removed: false }
  await db.chatChannelMember.delete({ where: { id: member.id } })
  return { removed: true }
}

/** Update the actor's own per-channel notification preference / mute. */
export async function setNotifyLevel(
  db: Db,
  input: { channelId: string; userId: string; notifyLevel: ChatNotifyLevel },
): Promise<{ ok: true }> {
  await ensureMembership(db, { channelId: input.channelId, userId: input.userId })
  await db.chatChannelMember.update({
    where: { channelId_userId: { channelId: input.channelId, userId: input.userId } },
    data: { notifyLevel: input.notifyLevel },
  })
  return { ok: true }
}

/**
 * Open (or fetch) a 1:1 / small-group DM channel between the actor and the
 * given others. Idempotent via the sorted dmKey. All participants get a
 * membership row so it appears in everyone's sidebar.
 */
export async function openDm(
  db: Db,
  input: { withUserIds: ReadonlyArray<string> },
  ctx: ActorCtx,
): Promise<{ id: string }> {
  const participants = [...new Set([ctx.actorId, ...input.withUserIds])]
  if (participants.length < 2) {
    throw new BusinessError('DM_NEEDS_MEMBER', 'Pick at least one person to message')
  }
  const key = dmKeyFor(participants)
  const existing = await db.chatChannel.findUnique({
    where: { dmKey: key },
    select: { id: true },
  })
  if (existing) {
    // Make sure every participant still has a membership row (re-open).
    for (const userId of participants) {
      await db.chatChannelMember.upsert({
        where: { channelId_userId: { channelId: existing.id, userId } },
        create: { id: createId(), channelId: existing.id, userId, role: 'member' },
        update: {},
      })
    }
    return { id: existing.id }
  }

  const id = createId()
  await db.chatChannel.create({
    data: {
      id,
      kind: 'dm',
      dmKey: key,
      createdById: ctx.actorId,
      members: {
        create: participants.map((userId) => ({
          id: createId(),
          userId,
          role: 'member',
          ...(userId === ctx.actorId ? { lastReadAt: new Date() } : {}),
        })),
      },
    },
  })
  return { id }
}

interface ChannelRow {
  id: string
  kind: 'public' | 'private' | 'dm'
  name: string | null
  topic: string | null
  description: string | null
  isGeneral: boolean
  archivedAt: Date | null
}

/**
 * Shape a channel row + the viewer's membership into the list/detail view-model
 * (unread + mention counts, DM title resolution). Counts are computed by the
 * caller (read-state) and threaded in to keep this pure-ish and batchable.
 */
export async function toChannelView(
  db: Db,
  row: ChannelRow,
  viewer: {
    member: boolean
    notifyLevel: ChatNotifyLevel
    muted: boolean
    lastReadAt: Date | null
  },
  counts: { unreadCount: number; mentionCount: number; lastMessageAt: Date | null },
  viewerId: string,
): Promise<ChatChannelView> {
  let title = row.name ? `#${row.name}` : 'Channel'
  let dmMembers: ChatUserLite[] = []

  if (row.kind === 'dm') {
    const members = await db.chatChannelMember.findMany({
      where: { channelId: row.id },
      select: { userId: true },
    })
    const otherIds = members.map((m) => m.userId).filter((uid) => uid !== viewerId)
    const userMap = await loadUsers(db, otherIds)
    dmMembers = otherIds.map(
      (uid) => userMap.get(uid) ?? { id: uid, name: 'Unknown', email: '' },
    )
    title = dmMembers.length > 0 ? dmMembers.map((u) => u.name).join(', ') : 'You'
  }

  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    title,
    topic: row.topic,
    description: row.description,
    isGeneral: row.isGeneral,
    archived: row.archivedAt != null,
    member: viewer.member,
    notifyLevel: viewer.notifyLevel,
    muted: viewer.muted,
    unreadCount: counts.unreadCount,
    mentionCount: counts.mentionCount,
    lastMessageAt: counts.lastMessageAt,
    dmMembers,
  }
}
