// Task router. CLAUDE.md §27 (tRPC), §13 (Asana ↔ task linkage).
//
// Read endpoints filter by assignee or status. Update/close are audited.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

const ListInput = z.object({
  cursor: z.object({ id: z.string(), createdAt: z.date() }).nullish(),
  limit: z.number().min(1).max(100).default(50),
  status: z.enum(TASK_STATUSES).optional(),
  /** "me" returns only tasks assigned to the calling user. "all" returns the team view. */
  scope: z.enum(['me', 'all']).default('me'),
})

const UpdateInput = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(280).optional(),
  description: z.string().trim().max(4000).nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.string().nullish(),
  dueAt: z.date().nullish(),
})

const CloseInput = z.object({
  id: z.string(),
  status: z.enum(['done', 'cancelled']).default('done'),
})

export const taskRouter = router({
  list: protectedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const rows = await ctx.db.task.findMany({
      where: {
        deletedAt: null,
        ...(input.status ? { status: input.status } : {}),
        ...(input.scope === 'me' ? { assigneeId: user.id } : {}),
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
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        assigneeId: true,
        familyId: true,
        contactId: true,
        dueAt: true,
        createdAt: true,
      },
    })
    const hasMore = rows.length > input.limit
    const sliced = hasMore ? rows.slice(0, input.limit) : rows
    const last = sliced[sliced.length - 1]
    return {
      items: sliced,
      nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
    }
  }),

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const before = await ctx.db.task.findFirst({
      where: { id: input.id, deletedAt: null },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    const after = await ctx.db.task.update({
      where: { id: input.id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.status !== undefined ? { status: input.status as TaskStatus } : {}),
        ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
        ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
        updatedById: user.id,
        lastWrittenBy: 'crm',
        lastWrittenAt: new Date(),
      },
    })
    await ctx.audit({
      action: 'task.updated',
      target: { type: 'Task', id: after.id },
      before,
      after,
    })
    return { id: after.id }
  }),

  close: auditedProcedure.input(CloseInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    const before = await ctx.db.task.findFirst({
      where: { id: input.id, deletedAt: null },
    })
    if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
    const after = await ctx.db.task.update({
      where: { id: input.id },
      data: {
        status: input.status,
        updatedById: user.id,
        lastWrittenBy: 'crm',
        lastWrittenAt: new Date(),
      },
    })
    await ctx.audit({
      action: 'task.closed',
      target: { type: 'Task', id: after.id },
      before,
      after,
    })
    return { id: after.id }
  }),
})
