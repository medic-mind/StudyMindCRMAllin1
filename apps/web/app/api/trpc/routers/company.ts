// Sister-brand companies (CLAUDE.md §4). Admin-editable — anyone can list,
// CEO + Senior Manager can create/update/archive/restore. Tagging on Contact
// + Family is done by storing companyId, so this router is the source of
// truth the rest of the UI reads from.

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

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only CEO and Senior Manager can manage companies',
    })
  }
}

const HEX_COLOR = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u, 'Use a #RRGGBB hex colour')

function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const CreateInput = z.object({
  name: z.string().trim().min(1).max(80),
  /** Optional explicit slug; otherwise derived from name. */
  slug: z.string().trim().min(1).max(60).optional(),
  color: HEX_COLOR.optional(),
  description: z.string().trim().max(280).optional(),
})

const UpdateInput = z.object({
  id: z.string(),
  name: z.string().trim().min(1).max(80).optional(),
  slug: z.string().trim().min(1).max(60).optional(),
  color: HEX_COLOR.nullish(),
  description: z.string().trim().max(280).nullish(),
})

export const companyRouter = router({
  list: protectedProcedure
    .input(
      z
        .object({
          includeArchived: z.boolean().default(false),
        })
        .default({ includeArchived: false }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.company.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ archivedAt: 'asc' }, { name: 'asc' }],
        include: {
          _count: { select: { contacts: true, families: true } },
        },
      })
      return rows.map((c) => ({
        id: c.id,
        name: c.name,
        slug: c.slug,
        color: c.color,
        description: c.description,
        archived: c.archivedAt != null,
        contactCount: c._count.contacts,
        familyCount: c._count.families,
      }))
    }),

  /** Tiny picker for selectors. Sorted, active only. */
  pickList: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.company.findMany({
      where: { archivedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, slug: true, color: true },
    })
  }),

  create: auditedProcedure
    .input(CreateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const slug = input.slug ?? slugify(input.name)
      if (!slug) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Could not derive a slug' })
      }
      const id = createId()
      try {
        const created = await ctx.db.company.create({
          data: {
            id,
            name: input.name,
            slug,
            color: input.color ?? null,
            description: input.description ?? null,
            createdById: user.id,
            updatedById: user.id,
          },
        })
        await ctx.audit({
          action: 'company.created',
          target: { type: 'Company', id: created.id },
          after: created,
        })
        return { id: created.id }
      } catch (err) {
        if (err instanceof Error && /Unique.*slug/i.test(err.message)) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A company with that slug already exists.',
          })
        }
        throw err
      }
    }),

  update: auditedProcedure
    .input(UpdateInput)
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.company.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.company.update({
        where: { id: input.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.slug !== undefined ? { slug: input.slug } : {}),
          color: input.color,
          description: input.description,
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'company.updated',
        target: { type: 'Company', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),

  archive: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanManage(user.role)
      const before = await ctx.db.company.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.company.update({
        where: { id: input.id },
        data: { archivedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({
        action: 'company.archived',
        target: { type: 'Company', id: after.id },
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
      const before = await ctx.db.company.findUnique({ where: { id: input.id } })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      const after = await ctx.db.company.update({
        where: { id: input.id },
        data: { archivedAt: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'company.restored',
        target: { type: 'Company', id: after.id },
        before,
        after,
      })
      return { id: after.id }
    }),
})
