// Slack channel catalogue (Settings → Slack channels). Operator-managed Slack
// channels the call-summary "Internal — Slack" section can post to, replacing
// the single env-configured SLACK_ALERTS_CHANNEL_ID. Each option carries
// optional deep-link action buttons rendered as Block Kit on the posted
// message so virtual assistants can click straight back into the CRM.
//
// Mirrors `callSummaryTemplate.*`: list / pickList / get / create / update /
// archive / restore. CLAUDE.md §20.1 — Manager+ for writes; all roles read.
// CLAUDE.md §12 — the watched-channel allowlist stays in code; this list is
// the OUTBOUND post targets for call summaries, an operational convenience.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  SlackChannelOptionCreateInput,
  SlackChannelOptionUpdateInput,
  parseActionButtons,
} from '@studymind/core/slack'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
])

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can manage Slack channels',
    })
  }
}

const CONFLICT_MESSAGE = 'A Slack channel with that id already exists.'

function mapUniqueError(err: unknown): never {
  if (err instanceof Error && /Unique.*channelId/i.test(err.message)) {
    throw new TRPCError({ code: 'CONFLICT', message: CONFLICT_MESSAGE })
  }
  throw err
}

export const slackChannelRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({ includeArchived: z.boolean().default(false) })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.slackChannelOption.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { sortOrder: 'asc' }, { label: 'asc' }],
      })
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        channelId: r.channelId,
        purpose: r.purpose,
        isDefault: r.isDefault,
        actionButtons: parseActionButtons(r.actionButtons),
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
      }))
    }),

  /** Lean selector for the call-summary "Internal — Slack" picker. */
  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.slackChannelOption.findMany({
      where: { archivedAt: null },
      orderBy: [{ isDefault: 'desc' }, { sortOrder: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, channelId: true, purpose: true, isDefault: true },
    })
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      channelId: r.channelId,
      purpose: r.purpose,
      isDefault: r.isDefault,
    }))
  }),

  create: auditedProcedure
    .input(SlackChannelOptionCreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const id = createId()
      try {
        const created = await ctx.db.$transaction(async (tx) => {
          if (input.isDefault) {
            await tx.slackChannelOption.updateMany({
              where: { isDefault: true },
              data: { isDefault: false },
            })
          }
          return tx.slackChannelOption.create({
            data: {
              id,
              label: input.label,
              channelId: input.channelId,
              purpose: input.purpose ?? null,
              isDefault: input.isDefault,
              actionButtons: input.actionButtons,
              sortOrder: input.sortOrder ?? 100,
              createdById: user.id,
              updatedById: user.id,
            },
          })
        })
        await ctx.audit({
          action: 'slack_channel_option.created',
          target: { type: 'SlackChannelOption', id: created.id },
          after: { label: created.label, channelId: created.channelId, isDefault: created.isDefault },
        })
        return { id: created.id }
      } catch (err) {
        mapUniqueError(err)
      }
    }),

  update: auditedProcedure
    .input(SlackChannelOptionUpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.slackChannelOption.findUnique({
        where: { id: input.id },
        select: { id: true, label: true, channelId: true, isDefault: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      try {
        const after = await ctx.db.$transaction(async (tx) => {
          if (input.isDefault === true) {
            await tx.slackChannelOption.updateMany({
              where: { isDefault: true, id: { not: input.id } },
              data: { isDefault: false },
            })
          }
          return tx.slackChannelOption.update({
            where: { id: input.id },
            data: {
              ...(input.label !== undefined ? { label: input.label } : {}),
              ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
              purpose: input.purpose,
              ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
              ...(input.actionButtons !== undefined ? { actionButtons: input.actionButtons } : {}),
              ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
              updatedById: user.id,
            },
            select: { id: true, label: true, channelId: true, isDefault: true },
          })
        })
        await ctx.audit({
          action: 'slack_channel_option.updated',
          target: { type: 'SlackChannelOption', id: after.id },
          before,
          after,
        })
        return { id: after.id }
      } catch (err) {
        mapUniqueError(err)
      }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.slackChannelOption.findUnique({
        where: { id: input.id },
        select: { id: true, label: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.slackChannelOption.update({
        where: { id: input.id },
        // Archiving clears the default flag so the picker never pre-selects a
        // hidden channel.
        data: { archivedAt: new Date(), isDefault: false, updatedById: user.id },
        select: { id: true, label: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'slack_channel_option.archived',
        target: { type: 'SlackChannelOption', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.slackChannelOption.findUnique({
        where: { id: input.id },
        select: { id: true, label: true, archivedAt: true },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.slackChannelOption.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
        select: { id: true, label: true, archivedAt: true },
      })
      await ctx.audit({
        action: 'slack_channel_option.restored',
        target: { type: 'SlackChannelOption', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),
})
