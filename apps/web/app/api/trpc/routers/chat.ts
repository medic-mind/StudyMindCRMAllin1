// Internal team messaging router (ADR 0022). Slack-style staff chat.
//
// RBAC (CLAUDE.md §20):
//   - Any authenticated staff member can read channels, post messages, reply in
//     threads, react, @mention, reference customers, and open DMs. Chat is a
//     collaboration surface, so even virtual_assistant participates fully.
//   - Creating / renaming / archiving channels and managing membership is
//     Manager+ (mirrors team + board management tiers).
//
// Audit (CLAUDE.md §27, §45.2): channel administration is audited; individual
// messages are high-volume staff↔staff chat and are deliberately not written to
// the compliance AuditLog or the customer Interaction timeline. The chat tables
// are not in the ESLint require-audit "sensitive model" set, so message
// mutations correctly use protectedProcedure.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  CreateChannelInput,
  EditMessageInput,
  ReactInput,
  SendMessageInput,
  UpdateChannelInput,
  addMember,
  archiveChannel,
  channelReadCounts,
  createChannel,
  deleteChannel,
  deleteMessage,
  editMessage,
  ensureMembership,
  hydrateMessages,
  listMentions,
  markAllMentionsRead,
  markChannelRead,
  markMentionRead,
  openDm,
  removeMember,
  restoreChannel,
  searchRefTargets,
  sendMessage,
  setNotifyLevel,
  toChannelView,
  toggleReaction,
  updateChannel,
  workspaceUnread,
  type ChatChannelView,
  type ChatNotifyLevel,
} from '@studymind/core/chat'
import { bodyToPlainText } from '@studymind/core/chat/parse'
import { publishChatActivity, type ChatActivityKind } from '@studymind/core/realtime'
import { BusinessError } from '@studymind/core/errors'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

// Channel administration tier (create/rename/archive/membership). Mirrors the
// board + team management tiers.
const CHANNEL_MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

// Moderation tier: delete anyone's message. Same as channel management.
const MODERATE_ROLES = CHANNEL_MANAGE_ROLES

function assertChannelManage(role: UserRole): void {
  if (!CHANNEL_MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager and above can manage channels',
    })
  }
}

function mapChatError(err: unknown): never {
  if (err instanceof BusinessError) {
    switch (err.code) {
      case 'CHANNEL_NOT_FOUND':
      case 'MESSAGE_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
      case 'CHANNEL_NAME_TAKEN':
        throw new TRPCError({ code: 'CONFLICT', message: err.message })
      case 'NOT_CHANNEL_MEMBER':
      case 'CHAT_FORBIDDEN':
      case 'CHANNEL_IS_GENERAL':
        throw new TRPCError({ code: 'FORBIDDEN', message: err.message })
      case 'CHANNEL_ARCHIVED':
      case 'MESSAGE_EMPTY':
      case 'DM_NEEDS_MEMBER':
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    }
  }
  throw err
}

const actor = (ctx: { user: { id: string }; requestId: string }) => ({
  actorId: ctx.user.id,
  requestId: ctx.requestId,
})

/**
 * Fire a realtime "something changed in this channel" hint so every connected
 * client can refetch the affected slice without polling (ADR 0022). Pure hint:
 * the payload never carries authoritative state, only enough for a client to
 * scope its invalidation and decide whether a mention is aimed at the viewer.
 * Best-effort — a bus failure must never fail the mutation that triggered it.
 */
function emitChatActivity(input: {
  kind: ChatActivityKind
  channelId: string
  messageId: string | null
  parentId: string | null
  actorId: string
  actorName: string | null
  mentionUserIds?: string[]
  preview?: string | null
}): void {
  try {
    publishChatActivity({
      kind: input.kind,
      channelId: input.channelId,
      messageId: input.messageId,
      parentId: input.parentId,
      actorId: input.actorId,
      actorName: input.actorName,
      mentionUserIds: input.mentionUserIds ?? [],
      preview: input.preview ?? null,
      occurredAt: new Date().toISOString(),
    })
  } catch {
    // Never let a realtime hint break the write path (CLAUDE.md §17).
  }
}

export const chatRouter = router({
  // --- Channel reads ---------------------------------------------------------

  /**
   * The sidebar list: every channel the viewer can see (their memberships +
   * all public channels), each with unread + mention counts, ordered by recent
   * activity. Archived channels are excluded unless asked for.
   */
  listChannels: protectedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }): Promise<{ channels: ChatChannelView[] }> => {
      const user = requireUser(ctx)

      const memberships = await ctx.db.chatChannelMember.findMany({
        where: { userId: user.id },
        select: {
          channelId: true,
          lastReadAt: true,
          notifyLevel: true,
          mutedAt: true,
        },
      })
      const membershipMap = new Map(memberships.map((m) => [m.channelId, m] as const))

      // Visible = my channels (any kind) ∪ all public channels.
      const channelRows = await ctx.db.chatChannel.findMany({
        where: {
          ...(input.includeArchived ? {} : { archivedAt: null }),
          OR: [
            { id: { in: memberships.map((m) => m.channelId) } },
            { kind: 'public' },
          ],
        },
        select: {
          id: true,
          kind: true,
          name: true,
          topic: true,
          description: true,
          isGeneral: true,
          archivedAt: true,
        },
      })

      const channels = await Promise.all(
        channelRows.map(async (row) => {
          const membership = membershipMap.get(row.id)
          // Discovery surface: public channels the user hasn't joined still
          // appear in the list, but they carry no unread/mention badge — there
          // is no "unread" for a channel you've never opened. We still surface
          // lastMessageAt so the list can sort by recent activity.
          const counts = membership
            ? await channelReadCounts(ctx.db, {
                channelId: row.id,
                userId: user.id,
                lastReadAt: membership.lastReadAt,
              })
            : await (async () => {
                const latest = await ctx.db.chatMessage.findFirst({
                  where: { channelId: row.id, deletedAt: null },
                  orderBy: { createdAt: 'desc' },
                  select: { createdAt: true },
                })
                return {
                  unreadCount: 0,
                  mentionCount: 0,
                  lastMessageAt: latest?.createdAt ?? null,
                }
              })()
          return toChannelView(
            ctx.db,
            row,
            {
              member: membership != null,
              notifyLevel: (membership?.notifyLevel ?? 'all') as ChatNotifyLevel,
              muted: membership?.mutedAt != null,
              lastReadAt: membership?.lastReadAt ?? null,
            },
            counts,
            user.id,
          )
        }),
      )

      // Sort: general first, then by most recent activity, then name.
      channels.sort((a, b) => {
        if (a.isGeneral !== b.isGeneral) return a.isGeneral ? -1 : 1
        const at = a.lastMessageAt?.getTime() ?? 0
        const bt = b.lastMessageAt?.getTime() ?? 0
        if (at !== bt) return bt - at
        return a.title.localeCompare(b.title)
      })

      return { channels }
    }),

  /** One channel's header view-model. Auto-joins public channels on open. */
  getChannel: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }): Promise<ChatChannelView> => {
      const user = requireUser(ctx)
      const row = await ctx.db.chatChannel.findUnique({
        where: { id: input.id },
        select: {
          id: true,
          kind: true,
          name: true,
          topic: true,
          description: true,
          isGeneral: true,
          archivedAt: true,
        },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })

      let membership = await ctx.db.chatChannelMember.findUnique({
        where: { channelId_userId: { channelId: input.id, userId: user.id } },
        select: { lastReadAt: true, notifyLevel: true, mutedAt: true },
      })
      // Auto-join public channels so opening one from the directory works.
      if (!membership && row.kind === 'public' && !row.archivedAt) {
        try {
          await ensureMembership(ctx.db, { channelId: input.id, userId: user.id })
          membership = { lastReadAt: null, notifyLevel: 'all', mutedAt: null }
        } catch {
          /* fall through as non-member */
        }
      }
      if (!membership && row.kind !== 'public') {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this channel' })
      }

      const counts = await channelReadCounts(ctx.db, {
        channelId: input.id,
        userId: user.id,
        lastReadAt: membership?.lastReadAt ?? null,
      })
      return toChannelView(
        ctx.db,
        row,
        {
          member: membership != null,
          notifyLevel: (membership?.notifyLevel ?? 'all') as ChatNotifyLevel,
          muted: membership?.mutedAt != null,
          lastReadAt: membership?.lastReadAt ?? null,
        },
        counts,
        user.id,
      )
    }),

  /** Members of a channel (for the header roster + @mention picker). */
  members: protectedProcedure
    .input(z.object({ channelId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.chatChannelMember.findMany({
        where: { channelId: input.channelId },
        select: { userId: true, role: true },
      })
      const users = await ctx.db.user.findMany({
        where: { id: { in: rows.map((r) => r.userId) } },
        select: { id: true, name: true, email: true },
      })
      const userMap = new Map(users.map((u) => [u.id, u] as const))
      return rows.map((r) => {
        const u = userMap.get(r.userId)
        return {
          userId: r.userId,
          name: (u?.name ?? '').trim() || u?.email || 'Unknown',
          email: u?.email ?? '',
          role: r.role,
        }
      })
    }),

  // --- Channel administration (Manager+) -------------------------------------

  createChannel: auditedProcedure
    .input(CreateChannelInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertChannelManage(user.role)
      try {
        const result = await createChannel(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.channel_created',
          target: { type: 'ChatChannel', id: result.id },
          after: { name: result.name, kind: input.kind },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  updateChannel: auditedProcedure
    .input(UpdateChannelInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertChannelManage(user.role)
      try {
        const result = await updateChannel(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.channel_updated',
          target: { type: 'ChatChannel', id: result.id },
          after: { name: input.name, topic: input.topic },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  archiveChannel: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertChannelManage(user.role)
      try {
        const result = await archiveChannel(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.channel_archived',
          target: { type: 'ChatChannel', id: result.id },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  restoreChannel: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertChannelManage(user.role)
      try {
        const result = await restoreChannel(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.channel_restored',
          target: { type: 'ChatChannel', id: result.id },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  /**
   * Hard-delete a channel and its entire history. Destructive + irreversible,
   * so it sits one tier above ordinary channel management — CEO + Senior
   * Manager only (mirrors board/team destructive ops). Audited; #general is
   * protected at the domain layer.
   */
  deleteChannel: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (user.role !== 'ceo' && user.role !== 'senior_manager') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only CEO and Senior Manager can permanently delete a channel',
        })
      }
      try {
        const result = await deleteChannel(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.channel_deleted',
          target: { type: 'ChatChannel', id: result.id },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  addMember: auditedProcedure
    .input(z.object({ channelId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertChannelManage(user.role)
      try {
        const result = await addMember(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.member_added',
          target: { type: 'ChatChannel', id: input.channelId },
          after: { userId: input.userId },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  removeMember: auditedProcedure
    .input(z.object({ channelId: z.string(), userId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Members may remove themselves (leave); managers may remove anyone.
      if (input.userId !== user.id) assertChannelManage(user.role)
      try {
        const result = await removeMember(ctx.db, input, actor({ user, requestId: ctx.requestId }))
        await ctx.audit({
          action: 'chat.member_removed',
          target: { type: 'ChatChannel', id: input.channelId },
          before: { userId: input.userId },
        })
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  /** Open or fetch a DM with one or more teammates. Any staff member. */
  openDm: protectedProcedure
    .input(z.object({ userIds: z.array(z.string().min(1)).min(1).max(8) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      try {
        return await openDm(
          ctx.db,
          { withUserIds: input.userIds },
          actor({ user, requestId: ctx.requestId }),
        )
      } catch (err) {
        mapChatError(err)
      }
    }),

  /** Set the viewer's per-channel notification level (all | mentions | none). */
  setNotifyLevel: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        notifyLevel: z.enum(['all', 'mentions', 'none']),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      try {
        return await setNotifyLevel(ctx.db, {
          channelId: input.channelId,
          userId: user.id,
          notifyLevel: input.notifyLevel,
        })
      } catch (err) {
        mapChatError(err)
      }
    }),

  // --- Messages --------------------------------------------------------------

  /**
   * Reverse-chronological page of top-level channel messages (newest first;
   * the client reverses for display). Thread replies are loaded separately via
   * `thread`.
   */
  listMessages: protectedProcedure
    .input(
      z.object({
        channelId: z.string(),
        cursor: z.object({ id: z.string(), createdAt: z.date() }).nullish(),
        limit: z.number().int().min(1).max(100).default(40),
      }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Reading a private channel requires membership; public channels are open.
      const channel = await ctx.db.chatChannel.findUnique({
        where: { id: input.channelId },
        select: { id: true, kind: true },
      })
      if (!channel) throw new TRPCError({ code: 'NOT_FOUND' })
      if (channel.kind !== 'public') {
        const membership = await ctx.db.chatChannelMember.findUnique({
          where: { channelId_userId: { channelId: input.channelId, userId: user.id } },
          select: { channelId: true },
        })
        if (!membership) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'You are not a member of this channel' })
        }
      }

      const rows = await ctx.db.chatMessage.findMany({
        where: {
          channelId: input.channelId,
          parentId: null,
          ...(input.cursor
            ? {
                OR: [
                  { createdAt: { lt: input.cursor.createdAt } },
                  {
                    AND: [
                      { createdAt: input.cursor.createdAt },
                      { id: { lt: input.cursor.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: messageSelect,
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const last = sliced[sliced.length - 1]

      const items = await hydrateMessages(ctx.db, sliced, user.id)
      return {
        items,
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

  /** All replies under a root message, oldest-first, plus the root itself. */
  thread: protectedProcedure
    .input(z.object({ rootId: z.string() }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const root = await ctx.db.chatMessage.findUnique({
        where: { id: input.rootId },
        select: messageSelect,
      })
      if (!root) throw new TRPCError({ code: 'NOT_FOUND' })

      const replies = await ctx.db.chatMessage.findMany({
        where: { parentId: input.rootId },
        orderBy: { createdAt: 'asc' },
        select: messageSelect,
      })
      const [rootView, replyViews] = await Promise.all([
        hydrateMessages(ctx.db, [root], user.id),
        hydrateMessages(ctx.db, replies, user.id),
      ])
      return { root: rootView[0]!, replies: replyViews }
    }),

  send: protectedProcedure.input(SendMessageInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    try {
      // Auto-join public channels on first post; private channels require a row.
      await ensureMembership(ctx.db, { channelId: input.channelId, userId: user.id })
      const message = await sendMessage(ctx.db, {
        channelId: input.channelId,
        authorId: user.id,
        body: input.body,
        parentId: input.parentId ?? null,
      })
      emitChatActivity({
        kind: 'message',
        channelId: message.channelId,
        messageId: message.id,
        parentId: message.parentId,
        actorId: user.id,
        actorName: message.authorName,
        mentionUserIds: message.mentionUserIds,
        // One-line preview for the desktop notification; tokens render as
        // readable labels (@Name / #Ref) rather than raw <@id> markers.
        preview: bodyToPlainText(input.body).slice(0, 140),
      })
      return message
    } catch (err) {
      mapChatError(err)
    }
  }),

  edit: protectedProcedure.input(EditMessageInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    try {
      const result = await editMessage(ctx.db, {
        id: input.id,
        authorId: user.id,
        body: input.body,
      })
      // Resolve the channel so other viewers refetch the edited row. Cheap —
      // one indexed lookup; skipped silently if the row vanished.
      const row = await ctx.db.chatMessage.findUnique({
        where: { id: input.id },
        select: { channelId: true, parentId: true },
      })
      if (row) {
        emitChatActivity({
          kind: 'edit',
          channelId: row.channelId,
          messageId: input.id,
          parentId: row.parentId,
          actorId: user.id,
          actorName: user.email,
        })
      }
      return result
    } catch (err) {
      mapChatError(err)
    }
  }),

  remove: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      try {
        // Capture the channel before the soft-delete so the hint can target it.
        const row = await ctx.db.chatMessage.findUnique({
          where: { id: input.id },
          select: { channelId: true, parentId: true },
        })
        const result = await deleteMessage(ctx.db, {
          id: input.id,
          actorId: user.id,
          allowAny: MODERATE_ROLES.has(user.role),
        })
        if (row) {
          emitChatActivity({
            kind: 'delete',
            channelId: row.channelId,
            messageId: input.id,
            parentId: row.parentId,
            actorId: user.id,
            actorName: user.email,
          })
        }
        return result
      } catch (err) {
        mapChatError(err)
      }
    }),

  react: protectedProcedure.input(ReactInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    try {
      const result = await toggleReaction(ctx.db, {
        messageId: input.messageId,
        userId: user.id,
        emoji: input.emoji,
      })
      const row = await ctx.db.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { channelId: true, parentId: true },
      })
      if (row) {
        emitChatActivity({
          kind: 'reaction',
          channelId: row.channelId,
          messageId: input.messageId,
          parentId: row.parentId,
          actorId: user.id,
          actorName: user.email,
        })
      }
      return result
    } catch (err) {
      mapChatError(err)
    }
  }),

  /**
   * Forward a message into another channel (Slack-style "Forward"). Re-posts
   * the original body verbatim — so its @mentions and customer refs re-resolve
   * as chips in the destination — quoted under an attribution line, plus the
   * forwarder's optional note. No new schema: it is a normal `send` into the
   * target channel, with the author's membership ensured first.
   */
  forward: protectedProcedure
    .input(
      z.object({
        messageId: z.string(),
        toChannelId: z.string(),
        note: z.string().trim().max(4000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      try {
        const source = await ctx.db.chatMessage.findFirst({
          where: { id: input.messageId, deletedAt: null },
          select: { id: true, body: true, authorId: true },
        })
        if (!source) throw new TRPCError({ code: 'NOT_FOUND', message: 'Message not found' })

        const author = await ctx.db.user.findUnique({
          where: { id: source.authorId },
          select: { name: true, email: true },
        })
        const authorName = (author?.name ?? '').trim() || author?.email || 'a teammate'

        // Attribution as a blockquote so the forwarded content reads as a quote
        // of the original; the note (if any) sits above it as the forwarder's
        // own words. Original tokens are preserved verbatim.
        const quoted = source.body
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        const body = [
          input.note ? input.note : null,
          `> _Forwarded from ${authorName}_`,
          quoted,
        ]
          .filter((x): x is string => x != null)
          .join('\n')

        await ensureMembership(ctx.db, { channelId: input.toChannelId, userId: user.id })
        const message = await sendMessage(ctx.db, {
          channelId: input.toChannelId,
          authorId: user.id,
          body,
        })
        emitChatActivity({
          kind: 'message',
          channelId: message.channelId,
          messageId: message.id,
          parentId: null,
          actorId: user.id,
          actorName: message.authorName,
          mentionUserIds: message.mentionUserIds,
          preview: bodyToPlainText(body).slice(0, 140),
        })
        return { id: message.id, channelId: message.channelId }
      } catch (err) {
        mapChatError(err)
      }
    }),

  // --- Read state ------------------------------------------------------------

  markRead: protectedProcedure
    .input(z.object({ channelId: z.string(), at: z.date().nullish() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      return markChannelRead(ctx.db, {
        channelId: input.channelId,
        userId: user.id,
        at: input.at ?? undefined,
      })
    }),

  /** Top-bar badge: unread messages + unread @mentions across the workspace. */
  unreadSummary: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    return workspaceUnread(ctx.db, { userId: user.id })
  }),

  // --- Mentions inbox --------------------------------------------------------

  mentions: protectedProcedure
    .input(
      z
        .object({
          onlyUnread: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(30),
        })
        .default({ onlyUnread: false, limit: 30 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const items = await listMentions(ctx.db, {
        userId: user.id,
        onlyUnread: input.onlyUnread,
        limit: input.limit,
      })
      return { items }
    }),

  markMentionRead: protectedProcedure
    .input(z.object({ mentionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      return markMentionRead(ctx.db, { mentionId: input.mentionId, userId: user.id })
    }),

  markAllMentionsRead: protectedProcedure.mutation(async ({ ctx }) => {
    const user = requireUser(ctx)
    return markAllMentionsRead(ctx.db, { userId: user.id })
  }),

  // --- Pickers ---------------------------------------------------------------

  /** Teammate picker for @mentions, DM-start, and add-member. */
  userSearch: protectedProcedure
    .input(z.object({ q: z.string().trim().max(80).optional() }))
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const rows = await ctx.db.user.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          id: { not: user.id },
          ...(input.q
            ? {
                OR: [
                  { name: { contains: input.q, mode: 'insensitive' as const } },
                  { email: { contains: input.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { name: 'asc' },
        take: 20,
        select: { id: true, name: true, email: true },
      })
      return rows.map((u) => ({
        id: u.id,
        name: (u.name ?? '').trim() || u.email,
        email: u.email,
      }))
    }),

  /** CRM-entity picker for the composer's "reference a customer" affordance. */
  refSearch: protectedProcedure
    .input(z.object({ q: z.string().trim().min(1).max(120), limit: z.number().int().min(1).max(10).optional() }))
    .query(async ({ ctx, input }) => {
      const results = await searchRefTargets(ctx.db, { query: input.q, limit: input.limit })
      return { results }
    }),
})

// Shared select for message rows fed into `hydrateMessages`.
const messageSelect = {
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
} as const
