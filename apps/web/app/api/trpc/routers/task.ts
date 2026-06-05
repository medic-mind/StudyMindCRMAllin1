// Task router. CLAUDE.md §27 (tRPC), §13 (Asana ↔ task linkage).
//
// Read endpoints filter by assignee or status. Update/close are audited.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { createId } from '@paralleldrive/cuid2'

import { addTaskComment, listTaskComments } from '@studymind/core/task'
import { BusinessError } from '@studymind/core/errors'
import { displayNameOf } from '@studymind/core/contact'

import { auditedProcedure, protectedProcedure, requireUser, router } from '@/lib/trpc/builders'

// Task field writes (create/update/close) are Sales Executive and above;
// Virtual Assistant is read + comment only (CLAUDE.md §20).
const TASK_WRITE_ROLES = new Set(['ceo', 'senior_manager', 'manager', 'sales_executive'])

function assertTaskWrite(role: string): void {
  if (!TASK_WRITE_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Your role cannot create or change tasks',
    })
  }
}

function mapTaskBusinessError(err: unknown): never {
  if (err instanceof BusinessError) {
    switch (err.code) {
      case 'TASK_NOT_FOUND':
        throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
      case 'COMMENT_EMPTY':
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
      default:
        throw new TRPCError({ code: 'BAD_REQUEST', message: err.message })
    }
  }
  throw err
}

const TASK_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const
type TaskStatus = (typeof TASK_STATUSES)[number]

const ListInput = z.object({
  cursor: z.object({ id: z.string(), createdAt: z.date() }).nullish(),
  limit: z.number().min(1).max(100).default(50),
  status: z.enum(TASK_STATUSES).optional(),
  /**
   * "me" → tasks assigned to the calling user.
   * "team" → tasks owned by any team the caller is a member of.
   * "all" → every task.
   */
  scope: z.enum(['me', 'team', 'all']).default('all'),
  /** Filter to a specific team. Overrides scope-derived team filtering. */
  teamId: z.string().nullish(),
  /** When true, only tasks with a dueAt in the past and not done/cancelled. */
  overdue: z.boolean().optional(),
})

const UpdateInput = z.object({
  id: z.string(),
  title: z.string().trim().min(1).max(280).optional(),
  description: z.string().trim().max(4000).nullish(),
  status: z.enum(TASK_STATUSES).optional(),
  assigneeId: z.string().nullish(),
  teamId: z.string().nullish(),
  dueAt: z.date().nullish(),
})

const CloseInput = z.object({
  id: z.string(),
  status: z.enum(['done', 'cancelled']).default('done'),
})

const CreateInput = z.object({
  title: z.string().trim().min(1).max(280),
  description: z.string().trim().max(4000).optional(),
  assigneeId: z.string().min(1),
  teamId: z.string().min(1).optional(),
  dueAt: z.date().optional(),
  contactId: z.string().min(1).optional(),
  familyId: z.string().min(1).optional(),
  businessAccountId: z.string().min(1).optional(),
})

export const taskRouter = router({
  list: protectedProcedure.input(ListInput).query(async ({ ctx, input }) => {
    const user = requireUser(ctx)

    // For scope="team", we need the team ids the caller belongs to so we can
    // filter tasks. One small query, then the main list builds a single where
    // clause from it.
    let teamFilter: { teamId: { in: string[] } } | { teamId: string } | undefined
    if (input.teamId) {
      teamFilter = { teamId: input.teamId }
    } else if (input.scope === 'team') {
      const memberships = await ctx.db.teamMember.findMany({
        where: { userId: user.id },
        select: { teamId: true },
      })
      teamFilter = { teamId: { in: memberships.map((m) => m.teamId) } }
    }

    const rows = await ctx.db.task.findMany({
      where: {
        deletedAt: null,
        ...(input.scope === 'me' ? { assigneeId: user.id } : {}),
        ...(teamFilter ?? {}),
        // Status: an explicit status filter wins. Otherwise, when "overdue" is
        // set we exclude terminal statuses so closed work never shows as late.
        ...(input.status
          ? { status: input.status }
          : input.overdue
            ? { status: { notIn: ['done', 'cancelled'] as TaskStatus[] } }
            : {}),
        ...(input.overdue ? { dueAt: { lt: new Date() } } : {}),
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
        teamId: true,
        familyId: true,
        contactId: true,
        dueAt: true,
        createdAt: true,
        family: { select: { name: true } },
        team: { select: { id: true, name: true, color: true } },
      },
    })
    const hasMore = rows.length > input.limit
    const sliced = hasMore ? rows.slice(0, input.limit) : rows
    const last = sliced[sliced.length - 1]

    // Hydrate assignee email/name in a single round-trip.
    const assigneeIds = Array.from(
      new Set(sliced.map((r) => r.assigneeId).filter((x): x is string => !!x)),
    )
    const assignees =
      assigneeIds.length > 0
        ? await ctx.db.user.findMany({
            where: { id: { in: assigneeIds } },
            select: { id: true, email: true, name: true },
          })
        : []
    const assigneeMap = new Map(assignees.map((a) => [a.id, a] as const))

    const items = sliced.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      status: r.status,
      assigneeId: r.assigneeId,
      familyId: r.familyId,
      familyName: r.family?.name ?? null,
      contactId: r.contactId,
      dueAt: r.dueAt,
      createdAt: r.createdAt,
      assigneeEmail: r.assigneeId
        ? (assigneeMap.get(r.assigneeId)?.email ?? null)
        : null,
      assigneeName: r.assigneeId
        ? (assigneeMap.get(r.assigneeId)?.name ?? null)
        : null,
      teamId: r.teamId,
      teamName: r.team?.name ?? null,
      teamColor: r.team?.color ?? null,
    }))

    return {
      items,
      nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
    }
  }),

  update: auditedProcedure.input(UpdateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertTaskWrite(user.role)
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
        ...(input.teamId !== undefined ? { teamId: input.teamId } : {}),
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

  /**
   * Lightweight user picker for task assignment. Any authenticated staff role
   * may list active users to choose an assignee. Returns id/email/name only;
   * roles and sensitive fields stay in the admin router.
   */
  assignableUsers: protectedProcedure
    .input(z.object({ q: z.string().trim().min(1).max(80).optional() }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.user.findMany({
        where: {
          deletedAt: null,
          isActive: true,
          ...(input.q
            ? {
                OR: [
                  { email: { contains: input.q, mode: 'insensitive' as const } },
                  { name: { contains: input.q, mode: 'insensitive' as const } },
                ],
              }
            : {}),
        },
        orderBy: { email: 'asc' },
        take: 50,
        select: { id: true, email: true, name: true },
      })
      return rows
    }),

  create: auditedProcedure.input(CreateInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertTaskWrite(user.role)
    // Validate referenced rows exist and aren't soft-deleted.
    if (input.contactId) {
      const c = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: { id: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
    }
    if (input.familyId) {
      const f = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        select: { id: true },
      })
      if (!f) throw new TRPCError({ code: 'NOT_FOUND', message: 'Family not found' })
    }
    if (input.businessAccountId) {
      const a = await ctx.db.businessAccount.findFirst({
        where: { id: input.businessAccountId },
        select: { id: true },
      })
      if (!a) throw new TRPCError({ code: 'NOT_FOUND', message: 'Account not found' })
    }
    const assignee = await ctx.db.user.findFirst({
      where: { id: input.assigneeId, deletedAt: null, isActive: true },
      select: { id: true },
    })
    if (!assignee) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assignee not found' })

    const id = createId()
    const created = await ctx.db.task.create({
      data: {
        id,
        title: input.title,
        description: input.description ?? null,
        status: 'open',
        assigneeId: assignee.id,
        teamId: input.teamId ?? null,
        contactId: input.contactId ?? null,
        familyId: input.familyId ?? null,
        businessAccountId: input.businessAccountId ?? null,
        dueAt: input.dueAt ?? null,
        createdById: user.id,
        updatedById: user.id,
        lastWrittenBy: 'crm',
        lastWrittenAt: new Date(),
      },
    })
    await ctx.audit({
      action: 'task.created',
      target: { type: 'Task', id: created.id },
      after: created,
    })
    return { id: created.id }
  }),

  close: auditedProcedure.input(CloseInput).mutation(async ({ ctx, input }) => {
    const user = requireUser(ctx)
    assertTaskWrite(user.role)
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

  /** Full task detail for the detail page / modal. Any authenticated role. */
  get: protectedProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const task = await ctx.db.task.findFirst({
      where: { id: input.id, deletedAt: null },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        assigneeId: true,
        contactId: true,
        familyId: true,
        dueAt: true,
        asanaTaskId: true,
        createdAt: true,
        family: { select: { name: true } },
      },
    })
    if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' })

    const [assignee, contact, taskComments] = await Promise.all([
      task.assigneeId
        ? ctx.db.user.findUnique({
            where: { id: task.assigneeId },
            select: { id: true, name: true, email: true },
          })
        : Promise.resolve(null),
      task.contactId
        ? ctx.db.contact.findFirst({
            where: { id: task.contactId, deletedAt: null },
            select: { id: true, firstName: true, lastName: true, email: true },
          })
        : Promise.resolve(null),
      listTaskComments(ctx.db, { taskId: task.id }),
    ])

    return {
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.status,
      assigneeId: task.assigneeId,
      assigneeName: assignee ? (assignee.name?.trim() || assignee.email) : null,
      contactId: task.contactId,
      contactName: contact ? displayNameOf(contact) : null,
      familyId: task.familyId,
      familyName: task.family?.name ?? null,
      dueAt: task.dueAt,
      asanaTaskId: task.asanaTaskId,
      createdAt: task.createdAt,
      commentCount: taskComments.length,
    }
  }),

  comments: router({
    list: protectedProcedure
      .input(z.object({ taskId: z.string() }))
      .query(async ({ ctx, input }) => {
        const comments = await listTaskComments(ctx.db, { taskId: input.taskId })
        return comments.map((c) => ({
          id: c.id,
          body: c.body,
          authorId: c.authorId,
          authorName: c.authorName,
          occurredAt: c.occurredAt,
        }))
      }),

    add: auditedProcedure
      .input(z.object({ taskId: z.string(), body: z.string().trim().min(1).max(4000) }))
      .mutation(async ({ ctx, input }) => {
        // Any authenticated user may comment (incl. virtual_assistant).
        const user = requireUser(ctx)
        try {
          const comment = await addTaskComment(
            ctx.db,
            { taskId: input.taskId, authorId: user.id, body: input.body },
            { actorId: user.id, requestId: ctx.requestId },
          )
          ctx.audit.called = true
          return {
            id: comment.id,
            body: comment.body,
            authorId: comment.authorId,
            authorName: comment.authorName,
            occurredAt: comment.occurredAt,
          }
        } catch (err) {
          mapTaskBusinessError(err)
        }
      }),
  }),
})
