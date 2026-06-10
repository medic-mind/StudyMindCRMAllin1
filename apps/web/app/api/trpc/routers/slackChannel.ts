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
  SLACK_TOPICS,
  SlackChannelOptionCreateInput,
  SlackChannelOptionUpdateInput,
  isSlackTopic,
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

/** Friendly copy for the Slack errors a test post can hit. */
function describeSlackError(code: string): string {
  switch (code) {
    case 'not_in_channel':
      return 'The bot is not in this channel yet. Open Slack and type /invite @YourBot in the channel, then test again.'
    case 'channel_not_found':
      return 'Slack does not recognise this channel id. Double-check it (or re-add the channel from the picker).'
    case 'is_archived':
      return 'That Slack channel is archived, so the bot cannot post to it.'
    case 'invalid_auth':
    case 'token_revoked':
    case 'account_inactive':
      return 'The Slack bot token is invalid or revoked. Reconnect Slack in Settings → Integrations.'
    case 'msg_too_long':
      return 'Slack rejected the message as too long.'
    default:
      return `Slack rejected the post (${code}).`
  }
}

export const slackChannelRouter = router({
  /**
   * Browse the Slack workspace's public channels by NAME so an operator can
   * add posting targets without hunting for channel ids. Fail-soft: returns a
   * status the UI can render as guidance (not configured / missing the
   * channels:read scope / transient error) instead of throwing — manual id
   * entry always remains available as the fallback (and is the only way to
   * add a private channel, which listing cannot see).
   */
  discover: protectedProcedure.query(async ({ ctx }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    if (!process.env['SLACK_BOT_TOKEN']) {
      return { status: 'not_configured' as const, channels: [] }
    }
    const { createClient, SlackApiError } = await import(
      '@studymind/integration-slack/client'
    )
    try {
      const channels = await createClient().listChannels()
      const existing = await ctx.db.slackChannelOption.findMany({
        select: { channelId: true },
      })
      const known = new Set(existing.map((r) => r.channelId))
      return {
        status: 'ok' as const,
        channels: channels.map((c) => ({
          id: c.id,
          name: c.name,
          isMember: c.isMember,
          alreadyAdded: known.has(c.id),
        })),
      }
    } catch (err) {
      if (err instanceof SlackApiError && err.slackError === 'missing_scope') {
        return { status: 'missing_scope' as const, channels: [] }
      }
      return {
        status: 'error' as const,
        channels: [],
        message: err instanceof SlackApiError ? err.slackError : 'unreachable',
      }
    }
  }),

  /**
   * Post a short test message to a configured channel so the operator can
   * verify the wiring (token valid, bot invited) BEFORE a real notification
   * needs it. Failures come back as friendly guidance, not errors.
   */
  testPost: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const option = await ctx.db.slackChannelOption.findFirst({
        where: { id: input.id, archivedAt: null },
        select: { id: true, label: true, channelId: true },
      })
      if (!option) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' })

      const { postAlert } = await import('@studymind/integration-slack/outbound')
      const { SlackApiError } = await import('@studymind/integration-slack/client')
      let result: { ok: true } | { ok: false; reason: string }
      try {
        await postAlert({
          message: `:white_check_mark: Test from StudyMind CRM — "${option.label}" is wired up. Sent by ${user.email}.`,
          // Unique per request so every click posts; a retry of the SAME
          // request stays idempotent (CLAUDE.md §17).
          idempotencyKey: `slack-channel-test:${option.id}:${ctx.requestId}`,
          channelId: option.channelId,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        result = { ok: true }
      } catch (err) {
        result = {
          ok: false,
          reason:
            err instanceof SlackApiError
              ? describeSlackError(err.slackError)
              : 'Could not reach Slack. Try again in a minute.',
        }
      }
      await ctx.audit({
        action: 'slack_channel_option.test_posted',
        target: { type: 'SlackChannelOption', id: option.id },
        after: { channelId: option.channelId, ...result },
      })
      return result
    }),

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

  // Notification routing — which channel each kind of message goes to. The
  // topic catalogue is code-defined (SLACK_TOPICS); admins map each to a
  // channel (or mute it) without a code change. CLAUDE.md §12.
  routes: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      const rows = await ctx.db.slackRoute.findMany({
        select: {
          topic: true,
          enabled: true,
          channelOptionId: true,
          channelOption: { select: { label: true, channelId: true, archivedAt: true } },
        },
      })
      const byTopic = new Map(rows.map((r) => [r.topic, r]))
      // Always return the full code-defined topic list so the UI shows every
      // routable message kind, with its current (or default) routing.
      return SLACK_TOPICS.map((t) => {
        const row = byTopic.get(t.key)
        return {
          topic: t.key,
          label: t.label,
          description: t.description,
          enabled: row?.enabled ?? true,
          channelOptionId: row?.channelOptionId ?? null,
          channelLabel: row?.channelOption?.label ?? null,
          channelId: row?.channelOption?.channelId ?? null,
          channelArchived: row?.channelOption?.archivedAt != null,
        }
      })
    }),

    set: auditedProcedure
      .input(
        z.object({
          topic: z.string(),
          channelOptionId: z.string().nullable(),
          enabled: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertCanManage(user.role)
        if (!isSlackTopic(input.topic)) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Unknown notification topic' })
        }
        if (input.channelOptionId) {
          const opt = await ctx.db.slackChannelOption.findFirst({
            where: { id: input.channelOptionId, archivedAt: null },
            select: { id: true },
          })
          if (!opt) throw new TRPCError({ code: 'NOT_FOUND', message: 'Channel not found' })
        }
        const before = await ctx.db.slackRoute.findUnique({
          where: { topic: input.topic },
          select: { channelOptionId: true, enabled: true },
        })
        await ctx.db.slackRoute.upsert({
          where: { topic: input.topic },
          create: {
            id: createId(),
            topic: input.topic,
            channelOptionId: input.channelOptionId,
            enabled: input.enabled,
            createdById: user.id,
            updatedById: user.id,
          },
          update: {
            channelOptionId: input.channelOptionId,
            enabled: input.enabled,
            updatedById: user.id,
          },
        })
        await ctx.audit({
          action: 'slack_route.updated',
          target: { type: 'SlackRoute', id: input.topic },
          before,
          after: { channelOptionId: input.channelOptionId, enabled: input.enabled },
        })
        return { ok: true }
      }),
  }),
})
