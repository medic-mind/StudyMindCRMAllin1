// Operator-managed subject + level/type catalogues for the webinar system.
// The "New class" workflow reads these dropdowns; admins add Biology / UCAT /
// GAMSAT / 11+ / … with no code change (CLAUDE.md §47). Manager+ manages; all
// roles read. Mutations are audited.

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

const MANAGE_ROLES: ReadonlySet<UserRole> = new Set<UserRole>(['ceo', 'senior_manager', 'manager'])

function assertCanManage(role: UserRole): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Only Manager or above can manage this' })
  }
}

/** Normalise a label into a stable handle: "A-Level" → "a_level". */
function toHandle(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
}

const CreateInput = z.object({
  label: z.string().trim().min(1).max(60),
  handle: z.string().trim().max(40).optional(),
  aliases: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const UpdateInput = z.object({
  id: z.string(),
  label: z.string().trim().min(1).max(60).optional(),
  aliases: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
})

const ArchiveInput = z.object({ id: z.string(), archived: z.boolean() })

export const webinarSubjectRouter = router({
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.webinarSubjectOption.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      })
      return rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        label: r.label,
        aliases: r.aliases,
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
      }))
    }),

  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.webinarSubjectOption.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      select: { handle: true, label: true },
    })
    return rows
  }),

  create: auditedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const handle = toHandle(input.handle || input.label)
    if (!handle) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid name.' })
    const id = createId()
    try {
      await ctx.db.webinarSubjectOption.create({
        data: {
          id,
          handle,
          label: input.label,
          aliases: input.aliases,
          sortOrder: input.sortOrder ?? 100,
          createdById: user.id,
          updatedById: user.id,
        },
      })
    } catch (err) {
      if (err instanceof Error && /Unique/i.test(err.message)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A subject with that handle already exists.' })
      }
      throw err
    }
    await ctx.audit({
      action: 'webinar.subject_created',
      target: { type: 'WebinarSubjectOption', id },
      after: { handle, label: input.label },
    })
    return { id, handle }
  }),

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const existing = await ctx.db.webinarSubjectOption.findUnique({ where: { id: input.id } })
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.webinarSubjectOption.update({
      where: { id: input.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedById: user.id,
      },
    })
    await ctx.audit({
      action: 'webinar.subject_updated',
      target: { type: 'WebinarSubjectOption', id: input.id },
      after: { label: input.label },
    })
    return { id: input.id }
  }),

  setArchived: auditedProcedure.input(ArchiveInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    await ctx.db.webinarSubjectOption.update({
      where: { id: input.id },
      data: { archivedAt: input.archived ? new Date() : null, updatedById: user.id },
    })
    await ctx.audit({
      action: 'webinar.subject_updated',
      target: { type: 'WebinarSubjectOption', id: input.id },
      after: { archived: input.archived },
    })
    return { id: input.id }
  }),
})

export const webinarLevelRouter = router({
  list: protectedProcedure
    .input(z.object({ includeArchived: z.boolean().default(false) }).default({ includeArchived: false }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.webinarLevelOption.findMany({
        where: input.includeArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      })
      return rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        label: r.label,
        aliases: r.aliases,
        sortOrder: r.sortOrder,
        archived: r.archivedAt != null,
      }))
    }),

  pickList: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.webinarLevelOption.findMany({
      where: { archivedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
      select: { handle: true, label: true },
    })
    return rows
  }),

  create: auditedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const handle = toHandle(input.handle || input.label)
    if (!handle) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Invalid name.' })
    const id = createId()
    try {
      await ctx.db.webinarLevelOption.create({
        data: {
          id,
          handle,
          label: input.label,
          aliases: input.aliases,
          sortOrder: input.sortOrder ?? 100,
          createdById: user.id,
          updatedById: user.id,
        },
      })
    } catch (err) {
      if (err instanceof Error && /Unique/i.test(err.message)) {
        throw new TRPCError({ code: 'CONFLICT', message: 'A level with that handle already exists.' })
      }
      throw err
    }
    await ctx.audit({
      action: 'webinar.level_created',
      target: { type: 'WebinarLevelOption', id },
      after: { handle, label: input.label },
    })
    return { id, handle }
  }),

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    const existing = await ctx.db.webinarLevelOption.findUnique({ where: { id: input.id } })
    if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
    await ctx.db.webinarLevelOption.update({
      where: { id: input.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.aliases !== undefined ? { aliases: input.aliases } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedById: user.id,
      },
    })
    await ctx.audit({
      action: 'webinar.level_updated',
      target: { type: 'WebinarLevelOption', id: input.id },
      after: { label: input.label },
    })
    return { id: input.id }
  }),

  setArchived: auditedProcedure.input(ArchiveInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertCanManage(user.role)
    await ctx.db.webinarLevelOption.update({
      where: { id: input.id },
      data: { archivedAt: input.archived ? new Date() : null, updatedById: user.id },
    })
    await ctx.audit({
      action: 'webinar.level_updated',
      target: { type: 'WebinarLevelOption', id: input.id },
      after: { archived: input.archived },
    })
    return { id: input.id }
  }),
})
