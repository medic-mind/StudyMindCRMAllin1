// Quick replies / canned responses (ADR 0020 Phase 6h).
//
// Saved message snippets agents insert into a conversation reply. Shared
// team-wide (v1). `list` is any staff (they use them); create/update/archive/
// restore are Manager+ (curating the shared catalogue). CLAUDE.md §20, §27.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

const CHANNELS = ['whatsapp', 'sms', 'email', 'web_chat'] as const

const UpsertInput = z.object({
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(4_000),
  channel: z.enum(CHANNELS).nullish(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
})

export const quickReplyRouter = router({
  /** All active quick replies, optionally filtered to a channel + the
   *  channel-agnostic ones. Any staff. */
  list: protectedProcedure
    .input(
      z
        .object({
          channel: z.enum(CHANNELS).nullish(),
          includeArchived: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.quickReply.findMany({
        where: {
          ownerUserId: null,
          ...(input?.includeArchived ? {} : { archivedAt: null }),
          ...(input?.channel
            ? { OR: [{ channel: input.channel }, { channel: null }] }
            : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { title: 'asc' }],
        take: 200,
        select: {
          id: true,
          title: true,
          body: true,
          channel: true,
          sortOrder: true,
          archivedAt: true,
        },
      })
      return rows
    }),

  create: auditedProcedure
    .input(UpsertInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!MANAGE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const id = createId()
      await ctx.db.quickReply.create({
        data: {
          id,
          title: input.title,
          body: input.body,
          channel: input.channel ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'quick_reply.created',
        target: { type: 'QuickReply', id },
        after: { title: input.title, channel: input.channel ?? null },
      })
      return { id }
    }),

  update: auditedProcedure
    .input(UpsertInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!MANAGE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const existing = await ctx.db.quickReply.findUnique({
        where: { id: input.id },
        select: { id: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.quickReply.update({
        where: { id: input.id },
        data: {
          title: input.title,
          body: input.body,
          channel: input.channel ?? null,
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'quick_reply.updated',
        target: { type: 'QuickReply', id: input.id },
        after: { title: input.title },
      })
      return { id: input.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string().min(1), restore: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      if (!MANAGE_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      const existing = await ctx.db.quickReply.findUnique({
        where: { id: input.id },
        select: { id: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.quickReply.update({
        where: { id: input.id },
        data: { archivedAt: input.restore ? null : new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: input.restore ? 'quick_reply.restored' : 'quick_reply.archived',
        target: { type: 'QuickReply', id: input.id },
        after: { restored: !!input.restore },
      })
      return { id: input.id }
    }),
})
