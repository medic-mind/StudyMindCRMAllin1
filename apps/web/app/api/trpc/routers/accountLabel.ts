// Account labels — a shared, staff-curated catalogue of free-form, colour-coded
// tags applied to B2B accounts (schools + B2B partners). Generic by design so a
// sibling junction can extend it to other entities later. Distinct from `Label`
// (board cards, ADR 0018) and `Company` (brand tags).
//
// `list` / `pickList` are any staff (they apply labels); create/update/archive/
// restore curate the shared catalogue and are Manager+. attach/detach apply a
// label to one account (Sales Executive+, who own account CRUD). CLAUDE.md §20,
// §27.

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

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set(['ceo', 'senior_manager', 'manager'])
const APPLY_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])

const HEX_COLOR = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a #RRGGBB hex colour')

const UpsertInput = z.object({
  name: z.string().trim().min(1).max(60),
  color: HEX_COLOR.nullish(),
  description: z.string().trim().max(280).nullish(),
  sortOrder: z.number().int().min(0).max(9_999).optional(),
})

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Manager or above can manage the label catalogue',
    })
  }
}

function assertCanApply(role: UserRole): void {
  if (!APPLY_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Sales Executive or above can apply labels',
    })
  }
}

export const accountLabelRouter = router({
  /** The whole catalogue. Any staff. Active-only unless `includeArchived`. */
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.accountLabel.findMany({
        where: input?.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: 500,
        select: {
          id: true,
          name: true,
          color: true,
          description: true,
          sortOrder: true,
          archivedAt: true,
          _count: { select: { accounts: true } },
        },
      })
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        color: r.color,
        description: r.description,
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
        usageCount: r._count.accounts,
      }))
    }),

  /** Lightweight active-only selector for pickers. Any staff. */
  pickList: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.accountLabel.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, color: true },
    })
  }),

  create: auditedProcedure.input(UpsertInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const id = createId()
    try {
      await ctx.db.accountLabel.create({
        data: {
          id,
          name: input.name,
          color: input.color ?? null,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
          createdById: user.id,
          updatedById: user.id,
        },
      })
    } catch (err) {
      if (err instanceof Error && /Unique.*name/i.test(err.message)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A label with that name already exists.' })
      }
      throw err
    }
    await ctx.audit({
      action: 'account_label.created',
      target: { type: 'AccountLabel', id },
      after: { name: input.name, color: input.color ?? null },
    })
    return { id }
  }),

  update: auditedProcedure
    .input(UpsertInput.extend({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.accountLabel.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      try {
        await ctx.db.accountLabel.update({
          where: { id: input.id },
          data: {
            name: input.name,
            color: input.color ?? null,
            description: input.description ?? null,
            ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
            updatedById: user.id,
          },
        })
      } catch (err) {
        if (err instanceof Error && /Unique.*name/i.test(err.message)) {
          throw new TRPCError({ code: 'CONFLICT', message: 'A label with that name already exists.' })
        }
        throw err
      }
      await ctx.audit({
        action: 'account_label.updated',
        target: { type: 'AccountLabel', id: input.id },
        before: { name: before.name, color: before.color },
        after: { name: input.name, color: input.color ?? null },
      })
      return { id: input.id }
    }),

  /** Archive or restore a label. Archiving keeps existing applications intact
   *  (the chip still renders) but hides it from pickers. Manager+. */
  archive: auditedProcedure
    .input(z.object({ id: z.string().min(1), restore: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const existing = await ctx.db.accountLabel.findUnique({
        where: { id: input.id },
        select: { id: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.accountLabel.update({
        where: { id: input.id },
        data: { archivedAt: input.restore ? null : new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: input.restore ? 'account_label.restored' : 'account_label.archived',
        target: { type: 'AccountLabel', id: input.id },
      })
      return { id: input.id }
    }),

  /** Apply one label to one account. Idempotent. Sales Executive+. */
  attach: auditedProcedure
    .input(z.object({ accountId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanApply(user.role)
      const [account, label] = await Promise.all([
        ctx.db.businessAccount.findUnique({
          where: { id: input.accountId },
          select: { id: true },
        }),
        ctx.db.accountLabel.findUnique({
          where: { id: input.labelId },
          select: { id: true, name: true },
        }),
      ])
      if (!account || !label) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.businessAccountLabel.upsert({
        where: { accountId_labelId: { accountId: account.id, labelId: label.id } },
        create: { accountId: account.id, labelId: label.id, createdById: user.id },
        update: {},
      })
      await ctx.audit({
        action: 'business_account.label_added',
        target: { type: 'BusinessAccount', id: account.id },
        after: { labelId: label.id, label: label.name },
      })
      return { ok: true }
    }),

  /** Remove one label from one account. Sales Executive+. */
  detach: auditedProcedure
    .input(z.object({ accountId: z.string(), labelId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanApply(user.role)
      await ctx.db.businessAccountLabel.deleteMany({
        where: { accountId: input.accountId, labelId: input.labelId },
      })
      await ctx.audit({
        action: 'business_account.label_removed',
        target: { type: 'BusinessAccount', id: input.accountId },
        after: { labelId: input.labelId },
      })
      return { ok: true }
    }),
})
