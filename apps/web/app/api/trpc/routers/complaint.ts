// Complaints router. A complaint is logged against a customer (Contact),
// appears on the Active complaints queue, can be worked with follow-ups +
// action points, converted into a Task, and resolved. Every customer-facing
// step writes a `note` Interaction on the contact timeline (so it is "synced
// to the customer's CRM") plus an audit row. Any staff can log, work, and
// resolve a complaint (product decision); Virtual Assistants included.
// CLAUDE.md §20, §27, §45.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

const StatusEnum = z.enum(['open', 'in_progress', 'resolved', 'dismissed'])
const SeverityEnum = z.enum(['low', 'medium', 'high'])
const ACTIVE_STATUSES = ['open', 'in_progress'] as const

/** Write a staff-visible note Interaction on the contact timeline so a
 *  complaint event is reflected in the customer's CRM. */
async function timelineNote(
  db: PrismaClient,
  input: {
    contactId: string
    summary: string
    event: string
    complaintId: string
    actorId: string | null
  },
): Promise<void> {
  await db.interaction.create({
    data: {
      id: createId(),
      type: 'note',
      contactId: input.contactId,
      occurredAt: new Date(),
      summary: input.summary.length > 120 ? `${input.summary.slice(0, 117)}…` : input.summary,
      payload: {
        event: input.event,
        kind: 'complaint',
        complaintId: input.complaintId,
        body: input.summary,
        authorId: input.actorId,
      },
      createdById: input.actorId,
      updatedById: input.actorId,
    },
  })
}

function displayName(c: {
  firstName: string | null
  lastName: string | null
  email: string | null
}): string {
  return [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || c.email || 'Contact'
}

export const complaintRouter = router({
  /** Active-complaints queue / per-contact list. */
  list: protectedProcedure
    .input(
      z
        .object({
          filter: z.enum(['active', 'all', 'resolved', 'mine']).default('active'),
          contactId: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .default({ filter: 'active', limit: 100 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const statusWhere =
        input.filter === 'active'
          ? { status: { in: [...ACTIVE_STATUSES] } }
          : input.filter === 'resolved'
            ? { status: { in: ['resolved', 'dismissed'] } }
            : {}
      const rows = await ctx.db.complaint.findMany({
        where: {
          deletedAt: null,
          ...(input.contactId ? { contactId: input.contactId } : {}),
          ...(input.filter === 'mine' ? { assigneeId: user.id, status: { in: [...ACTIVE_STATUSES] } } : {}),
          ...statusWhere,
        },
        orderBy: [{ createdAt: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          title: true,
          status: true,
          severity: true,
          category: true,
          assigneeId: true,
          taskId: true,
          createdAt: true,
          resolvedAt: true,
          contact: { select: { id: true, firstName: true, lastName: true, email: true } },
          _count: { select: { updates: true } },
        },
      })
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        status: r.status,
        severity: r.severity,
        category: r.category,
        assigneeId: r.assigneeId,
        taskId: r.taskId,
        createdAt: r.createdAt,
        resolvedAt: r.resolvedAt,
        contactId: r.contact.id,
        contactName: displayName(r.contact),
        updateCount: r._count.updates,
      }))
    }),

  /** Count of active complaints — for the sidebar badge. */
  activeCount: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.complaint.count({
      where: { deletedAt: null, status: { in: [...ACTIVE_STATUSES] } },
    })
  }),

  /** Live backlog + opened-in-period — for the report KPI strips (Aircall /
   *  Finance). `activeBacklog` is a "now" figure; `openedInPeriod` tracks the
   *  report's period selector so the tile responds to it. */
  periodCounts: protectedProcedure
    .input(z.object({ from: z.date(), to: z.date() }))
    .query(async ({ ctx, input }) => {
      const to = new Date(input.to)
      to.setUTCHours(23, 59, 59, 999)
      const [activeBacklog, openedInPeriod] = await Promise.all([
        ctx.db.complaint.count({
          where: { deletedAt: null, status: { in: [...ACTIVE_STATUSES] } },
        }),
        ctx.db.complaint.count({
          where: { deletedAt: null, createdAt: { gte: input.from, lte: to } },
        }),
      ])
      return { activeBacklog, openedInPeriod }
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: {
          id: true,
          title: true,
          description: true,
          status: true,
          severity: true,
          category: true,
          assigneeId: true,
          taskId: true,
          resolution: true,
          resolvedAt: true,
          createdAt: true,
          contact: { select: { id: true, firstName: true, lastName: true, email: true } },
          updates: {
            orderBy: { createdAt: 'asc' },
            select: {
              id: true,
              body: true,
              isActionPoint: true,
              done: true,
              createdAt: true,
              createdById: true,
            },
          },
        },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      return {
        ...c,
        contactName: displayName(c.contact),
      }
    }),

  create: auditedProcedure
    .input(
      z.object({
        contactId: z.string(),
        title: z.string().trim().min(2).max(200),
        description: z.string().trim().max(4000).optional(),
        severity: SeverityEnum.default('medium'),
        category: z.string().trim().max(80).optional(),
        assigneeId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: { id: true },
      })
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      const id = createId()
      await ctx.db.complaint.create({
        data: {
          id,
          contactId: input.contactId,
          title: input.title,
          description: input.description ?? null,
          severity: input.severity,
          category: input.category ?? null,
          assigneeId: input.assigneeId ?? null,
          status: 'open',
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await timelineNote(ctx.db, {
        contactId: input.contactId,
        summary: `Complaint raised: ${input.title}`,
        event: 'complaint.raised',
        complaintId: id,
        actorId: user.id,
      })
      await ctx.audit({
        action: 'complaint.created',
        target: { type: 'Complaint', id },
        after: { contactId: input.contactId, title: input.title, severity: input.severity },
      })
      return { id }
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        status: StatusEnum.optional(),
        severity: SeverityEnum.optional(),
        category: z.string().trim().max(80).nullish(),
        assigneeId: z.string().nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const existing = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.severity !== undefined ? { severity: input.severity } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          updatedById: user.id,
        },
      })
      await ctx.audit({
        action: 'complaint.updated',
        target: { type: 'Complaint', id: input.id },
        after: {
          status: input.status,
          severity: input.severity,
          assigneeId: input.assigneeId,
        },
      })
      return { ok: true }
    }),

  /** Add a follow-up note or action point. */
  addUpdate: auditedProcedure
    .input(
      z.object({
        complaintId: z.string(),
        body: z.string().trim().min(1).max(4000),
        isActionPoint: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.complaintId, deletedAt: null },
        select: { id: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      const id = createId()
      await ctx.db.complaintUpdate.create({
        data: {
          id,
          complaintId: input.complaintId,
          body: input.body,
          isActionPoint: input.isActionPoint,
          createdById: user.id,
        },
      })
      await ctx.audit({
        action: 'complaint.update_added',
        target: { type: 'Complaint', id: input.complaintId },
        after: { updateId: id, isActionPoint: input.isActionPoint },
      })
      return { id }
    }),

  /** Tick / untick an action point. */
  setActionPointDone: auditedProcedure
    .input(z.object({ updateId: z.string(), done: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.complaintUpdate.findUnique({
        where: { id: input.updateId },
        select: { id: true, complaintId: true },
      })
      if (!row) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaintUpdate.update({
        where: { id: input.updateId },
        data: { done: input.done },
      })
      await ctx.audit({
        action: 'complaint.action_point_toggled',
        target: { type: 'Complaint', id: row.complaintId },
        after: { updateId: input.updateId, done: input.done },
      })
      return { ok: true }
    }),

  /** Resolve (or dismiss) a complaint. Any staff. */
  resolve: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        resolution: z.string().trim().max(4000).optional(),
        dismiss: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, contactId: true, title: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: {
          status: input.dismiss ? 'dismissed' : 'resolved',
          resolution: input.resolution ?? null,
          resolvedAt: new Date(),
          resolvedById: user.id,
          updatedById: user.id,
        },
      })
      await timelineNote(ctx.db, {
        contactId: c.contactId,
        summary: `${input.dismiss ? 'Complaint dismissed' : 'Complaint resolved'}: ${c.title}${
          input.resolution ? ` — ${input.resolution}` : ''
        }`,
        event: input.dismiss ? 'complaint.dismissed' : 'complaint.resolved',
        complaintId: c.id,
        actorId: user.id,
      })
      await ctx.audit({
        action: input.dismiss ? 'complaint.dismissed' : 'complaint.resolved',
        target: { type: 'Complaint', id: input.id },
        after: { resolution: input.resolution ?? null },
      })
      return { ok: true }
    }),

  /** Reopen a resolved/dismissed complaint. */
  reopen: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: { status: 'open', resolvedAt: null, resolvedById: null, updatedById: user.id },
      })
      await ctx.audit({
        action: 'complaint.reopened',
        target: { type: 'Complaint', id: input.id },
      })
      return { ok: true }
    }),

  /** Convert a complaint into a follow-up Task (one per complaint). */
  createTask: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        assigneeId: z.string().optional(),
        dueAt: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, contactId: true, title: true, description: true, taskId: true, assigneeId: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      if (c.taskId) {
        return { taskId: c.taskId, alreadyLinked: true }
      }
      const taskId = createId()
      await ctx.db.task.create({
        data: {
          id: taskId,
          title: `Complaint: ${c.title}`,
          description: c.description ?? null,
          status: 'open',
          contactId: c.contactId,
          assigneeId: input.assigneeId ?? c.assigneeId ?? null,
          dueAt: input.dueAt ?? null,
          createdById: user.id,
          updatedById: user.id,
        },
      })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: { taskId, updatedById: user.id },
      })
      await ctx.audit({
        action: 'complaint.task_created',
        target: { type: 'Complaint', id: input.id },
        after: { taskId },
      })
      return { taskId, alreadyLinked: false }
    }),
})
