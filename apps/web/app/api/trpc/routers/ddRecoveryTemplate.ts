// Direct Debit recovery-comms templates (ADR 0038, Phase 3).
//
// Staff-authored reminder / legal-escalation copy used to draft a
// human-confirmed send from a recovery case. We ship NO copy — bodies start
// empty and Managers write them (legal wording is theirs). `list`/`pickList`
// are finance-role reads; create/update/archive/restore are Manager+.
// CLAUDE.md §20, §27, §3 (nothing sends here).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { protectedProcedure, requireUser, router, type UserRole } from '@/lib/trpc/builders'

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])
const FINANCE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

const KINDS = ['reminder', 'legal_escalation', 'other'] as const
const CHANNELS = ['email', 'trengo', 'sms'] as const

function assertManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Manager and above only' })
  }
}
function assertFinance(role: UserRole): void {
  if (!FINANCE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Finance roles only' })
  }
}

const UpsertInput = z.object({
  name: z.string().trim().min(1).max(120),
  kind: z.enum(KINDS),
  channel: z.enum(CHANNELS),
  subject: z.string().trim().max(200).nullish(),
  body: z.string().max(10_000),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
})

const SELECT = {
  id: true,
  name: true,
  kind: true,
  channel: true,
  subject: true,
  body: true,
  sortOrder: true,
  archivedAt: true,
} as const

export const ddRecoveryTemplateRouter = router({
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      assertFinance(requireUser(ctx).role)
      return ctx.db.ddRecoveryTemplate.findMany({
        where: { deletedAt: null, ...(input?.includeArchived ? {} : { archivedAt: null }) },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 200,
        select: SELECT,
      })
    }),

  /** Active templates for the case send picker, optionally by channel. */
  pickList: protectedProcedure
    .input(z.object({ channel: z.enum(CHANNELS).nullish() }).optional())
    .query(async ({ ctx, input }) => {
      assertFinance(requireUser(ctx).role)
      return ctx.db.ddRecoveryTemplate.findMany({
        where: {
          deletedAt: null,
          archivedAt: null,
          ...(input?.channel ? { channel: input.channel } : {}),
        },
        orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }, { name: 'asc' }],
        take: 200,
        select: SELECT,
      })
    }),

  create: protectedProcedure.input(UpsertInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertManage(user.role)
    const row = await ctx.db.ddRecoveryTemplate.create({
      data: {
        id: createId(),
        name: input.name,
        kind: input.kind,
        channel: input.channel,
        subject: input.subject ?? null,
        body: input.body,
        sortOrder: input.sortOrder ?? 0,
        createdById: user.id,
        updatedById: user.id,
      },
      select: SELECT,
    })
    await ctx.audit({
      action: 'dd_recovery_template.created',
      target: { type: 'DdRecoveryTemplate', id: row.id },
      after: { name: row.name, kind: row.kind, channel: row.channel },
    })
    return row
  }),

  update: protectedProcedure
    .input(UpsertInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      const row = await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: {
          name: input.name,
          kind: input.kind,
          channel: input.channel,
          subject: input.subject ?? null,
          body: input.body,
          sortOrder: input.sortOrder ?? 0,
          updatedById: user.id,
        },
        select: SELECT,
      })
      await ctx.audit({
        action: 'dd_recovery_template.updated',
        target: { type: 'DdRecoveryTemplate', id: row.id },
        after: { name: row.name, kind: row.kind, channel: row.channel },
      })
      return row
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'dd_recovery_template.archived',
        target: { type: 'DdRecoveryTemplate', id: input.id },
      })
      return { ok: true }
    }),

  restore: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertManage(user.role)
      await ctx.db.ddRecoveryTemplate.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'dd_recovery_template.restored',
        target: { type: 'DdRecoveryTemplate', id: input.id },
      })
      return { ok: true }
    }),
})
