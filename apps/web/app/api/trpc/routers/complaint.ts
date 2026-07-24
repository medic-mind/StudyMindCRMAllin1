// Complaints router. Complaints are logged IN the CRM (Slack auto-ingestion was
// removed, 2026-07). A complaint is logged against a CRM customer (Contact) OR a
// manually-typed person (name + phone) when they're not in the CRM; either way
// it ALWAYS posts to the Slack #complaintcallsummaries channel via the connected
// bot and anchors a thread that mirrors follow-up updates into Slack and logs
// them onto the customer's CRM timeline. Full lifecycle: work with thread
// updates + action points, reassign, resolve/dismiss/reopen, archive/unarchive,
// delete/restore, and permanently delete. Any staff can log, work and resolve a
// complaint; delete + permanent-delete are role-gated. CLAUDE.md §20, §27, §45.

import { createId } from '@paralleldrive/cuid2'
import type { PrismaClient } from '@prisma/client'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { complaintCustomer } from '@/lib/complaints/customer'
import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

const StatusEnum = z.enum(['open', 'in_progress', 'resolved', 'dismissed'])
const SeverityEnum = z.enum(['low', 'medium', 'high'])
const ACTIVE_STATUSES = ['open', 'in_progress'] as const
const TERMINAL_STATUSES = new Set(['resolved', 'dismissed'])

// Complaints are an OPERATIONAL surface: every staff role (Virtual Assistant
// included) can log, work, resolve, archive, delete/restore and permanently
// delete a complaint — consistent with the 2026-07 policy (only integrations +
// user-management are admin-only). Destructive actions are guarded by a
// confirm dialog + an audit row, not a role gate.

/** Preset complaint themes (Complaint.category stays free text — these seed the
 *  pick-list; staff can always type a new one). */
const PRESET_CATEGORIES = [
  'Billing',
  'Scheduling',
  'Tutor',
  'Teaching quality',
  'Communication',
  'Refund',
  'Technical',
  'Safeguarding',
  'Other',
] as const

const CONTACT_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phoneE164: true,
} as const

/** Write a staff-visible note Interaction on the contact timeline so a complaint
 *  event is reflected on the customer's CRM record. No-op for a manual complaint
 *  (no CRM contact to log against — the complaint record itself is the trail). */
async function timelineNote(
  db: PrismaClient,
  input: {
    contactId: string | null
    summary: string
    event: string
    complaintId: string
    actorId: string | null
  },
): Promise<void> {
  if (!input.contactId) return
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

/** Resolve a batch of user ids to display names for assignee chips. */
async function resolveUserNames(
  db: PrismaClient,
  ids: ReadonlyArray<string | null>,
): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (unique.length === 0) return new Map()
  const users = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true, email: true },
  })
  return new Map(users.map((u) => [u.id, u.name?.trim() || u.email]))
}

export const complaintRouter = router({
  /** Complaints queue / per-contact list. */
  list: protectedProcedure
    .input(
      z
        .object({
          filter: z.enum(['active', 'all', 'resolved', 'mine', 'archived']).default('active'),
          contactId: z.string().optional(),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .default({ filter: 'active', limit: 100 }),
    )
    .query(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // A per-contact list (the contact page) shows every non-deleted complaint
      // for that customer, archived included (labelled), regardless of filter.
      const where = input.contactId
        ? { deletedAt: null, contactId: input.contactId }
        : input.filter === 'archived'
          ? { deletedAt: null, archivedAt: { not: null } }
          : input.filter === 'active'
            ? { deletedAt: null, archivedAt: null, status: { in: [...ACTIVE_STATUSES] } }
            : input.filter === 'mine'
              ? {
                  deletedAt: null,
                  archivedAt: null,
                  assigneeId: user.id,
                  status: { in: [...ACTIVE_STATUSES] },
                }
              : input.filter === 'resolved'
                ? { deletedAt: null, archivedAt: null, status: { in: ['resolved', 'dismissed'] } }
                : { deletedAt: null, archivedAt: null } // all
      const rows = await ctx.db.complaint.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        take: input.limit,
        select: {
          id: true,
          title: true,
          status: true,
          severity: true,
          category: true,
          assigneeId: true,
          createdAt: true,
          resolvedAt: true,
          archivedAt: true,
          personName: true,
          personPhone: true,
          personEmail: true,
          contact: { select: CONTACT_SELECT },
          _count: { select: { updates: true } },
        },
      })
      const assigneeNames = await resolveUserNames(ctx.db, rows.map((r) => r.assigneeId))
      return rows.map((r) => {
        const cust = complaintCustomer(r)
        return {
          id: r.id,
          title: r.title,
          status: r.status,
          severity: r.severity,
          category: r.category,
          assigneeId: r.assigneeId,
          assigneeName: r.assigneeId ? (assigneeNames.get(r.assigneeId) ?? null) : null,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
          archived: r.archivedAt != null,
          contactId: cust.contactId,
          customerName: cust.name,
          isManual: cust.manual,
          updateCount: r._count.updates,
        }
      })
    }),

  /** Count of active (open + in progress, not archived) complaints — sidebar badge. */
  activeCount: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.complaint.count({
      where: { deletedAt: null, archivedAt: null, status: { in: [...ACTIVE_STATUSES] } },
    })
  }),

  /** Management headline stats for the top-level Complaints dashboard. */
  dashboardStats: protectedProcedure.query(async ({ ctx }) => {
    const now = Date.now()
    const since30 = new Date(now - 30 * 86_400_000)
    const since90 = new Date(now - 90 * 86_400_000)
    const [activeGroups, openedLast30, resolvedLast30, unassignedActive, resolvedRows] =
      await Promise.all([
        ctx.db.complaint.groupBy({
          by: ['severity'],
          where: { deletedAt: null, archivedAt: null, status: { in: [...ACTIVE_STATUSES] } },
          _count: true,
        }),
        ctx.db.complaint.count({ where: { deletedAt: null, createdAt: { gte: since30 } } }),
        ctx.db.complaint.count({ where: { deletedAt: null, resolvedAt: { gte: since30 } } }),
        ctx.db.complaint.count({
          where: {
            deletedAt: null,
            archivedAt: null,
            status: { in: [...ACTIVE_STATUSES] },
            assigneeId: null,
          },
        }),
        ctx.db.complaint.findMany({
          where: { deletedAt: null, resolvedAt: { gte: since90 } },
          select: { createdAt: true, resolvedAt: true },
        }),
      ])

    const bySeverity = { high: 0, medium: 0, low: 0 }
    for (const g of activeGroups) {
      const k = g.severity as 'high' | 'medium' | 'low'
      if (k in bySeverity) bySeverity[k] = g._count
    }
    const activeBacklog = bySeverity.high + bySeverity.medium + bySeverity.low

    const hours = resolvedRows
      .map((r) => (r.resolvedAt ? (r.resolvedAt.getTime() - r.createdAt.getTime()) / 3_600_000 : null))
      .filter((x): x is number => x != null && x >= 0)
    const avgResolutionHours =
      hours.length > 0 ? Math.round((hours.reduce((a, b) => a + b, 0) / hours.length) * 10) / 10 : null

    return {
      activeBacklog,
      bySeverity,
      highSeverityActive: bySeverity.high,
      unassignedActive,
      openedLast30,
      resolvedLast30,
      avgResolutionHours,
    }
  }),

  /** Category pick-list for the log-complaint form. */
  categories: protectedProcedure.query(async ({ ctx }) => {
    const used = await ctx.db.complaint.findMany({
      where: { deletedAt: null, category: { not: null } },
      select: { category: true },
      distinct: ['category'],
      take: 200,
    })
    const seen = new Set(PRESET_CATEGORIES.map((c) => c.toLowerCase()))
    const extras: string[] = []
    for (const row of used) {
      const c = row.category?.trim()
      if (!c) continue
      const key = c.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      extras.push(c)
    }
    extras.sort((a, b) => a.localeCompare(b))
    return [...PRESET_CATEGORIES, ...extras]
  }),

  /** Active staff for the assignee picker. */
  assignableUsers: protectedProcedure.query(async ({ ctx }) => {
    const users = await ctx.db.user.findMany({
      where: { deactivatedAt: null, deletedAt: null },
      select: { id: true, name: true, email: true },
      orderBy: [{ name: 'asc' }, { email: 'asc' }],
      take: 200,
    })
    return users.map((u) => ({ id: u.id, name: u.name?.trim() || u.email, email: u.email }))
  }),

  /** Live backlog + opened-in-period — for the report KPI strips. */
  periodCounts: protectedProcedure
    .input(z.object({ from: z.date(), to: z.date() }))
    .query(async ({ ctx, input }) => {
      const to = new Date(input.to)
      to.setUTCHours(23, 59, 59, 999)
      const [activeBacklog, openedInPeriod] = await Promise.all([
        ctx.db.complaint.count({
          where: { deletedAt: null, archivedAt: null, status: { in: [...ACTIVE_STATUSES] } },
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
          resolution: true,
          resolvedAt: true,
          archivedAt: true,
          createdAt: true,
          createdById: true,
          slackChannelId: true,
          slackMessageTs: true,
          slackChannelName: true,
          personName: true,
          personPhone: true,
          personEmail: true,
          contact: { select: CONTACT_SELECT },
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
      const cust = complaintCustomer(c)
      const authorIds = [c.createdById, ...c.updates.map((u) => u.createdById)]
      const names = await resolveUserNames(ctx.db, [...authorIds, c.assigneeId])
      return {
        id: c.id,
        title: c.title,
        description: c.description,
        status: c.status,
        severity: c.severity,
        category: c.category,
        resolution: c.resolution,
        resolvedAt: c.resolvedAt,
        archived: c.archivedAt != null,
        createdAt: c.createdAt,
        postedToSlack: Boolean(c.slackMessageTs),
        // The REAL channel it was posted to (falls back to the canonical name
        // for complaints logged before this was captured).
        slackChannelName: c.slackChannelName ?? (c.slackMessageTs ? '#complaintcallsummaries' : null),
        assigneeId: c.assigneeId,
        assigneeName: c.assigneeId ? (names.get(c.assigneeId) ?? null) : null,
        contactId: cust.contactId,
        customerName: cust.name,
        customerPhone: cust.phone,
        customerEmail: cust.email,
        isManual: cust.manual,
        updates: c.updates.map((u) => ({
          ...u,
          authorName: u.createdById ? (names.get(u.createdById) ?? null) : null,
        })),
      }
    }),

  create: auditedProcedure
    .input(
      z
        .object({
          contactId: z.string().optional(),
          person: z
            .object({
              name: z.string().trim().min(2).max(120),
              phone: z.string().trim().max(40).optional(),
              email: z.string().trim().max(200).optional(),
            })
            .optional(),
          title: z.string().trim().min(2).max(200),
          description: z.string().trim().max(4000).optional(),
          severity: SeverityEnum.default('medium'),
          category: z.string().trim().max(80).optional(),
          assigneeId: z.string().optional(),
        })
        .refine((v) => Boolean(v.contactId) || Boolean(v.person?.name), {
          message: 'Pick a customer from the CRM, or type a name to log it manually.',
          path: ['contactId'],
        }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      // Prefer a linked CRM contact; a manual person is stored only when no
      // contact is chosen (never a silent contact create — §3).
      let contactId: string | null = null
      if (input.contactId) {
        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
        contactId = contact.id
      }
      const manual = contactId ? null : (input.person ?? null)

      const id = createId()
      await ctx.db.complaint.create({
        data: {
          id,
          contactId,
          personName: manual?.name ?? null,
          personPhone: manual?.phone ?? null,
          personEmail: manual?.email ?? null,
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
        contactId,
        summary: `Complaint raised: ${input.title}`,
        event: 'complaint.raised',
        complaintId: id,
        actorId: user.id,
      })
      await ctx.audit({
        action: 'complaint.created',
        target: { type: 'Complaint', id },
        after: {
          contactId,
          manual: Boolean(manual),
          personName: manual?.name ?? null,
          title: input.title,
          severity: input.severity,
          category: input.category ?? null,
        },
      })

      // ALWAYS announce to the operator-routed #complaintcallsummaries channel
      // and anchor the thread (best-effort — a Slack failure never fails logging
      // the complaint). The status is returned so the UI can echo it.
      const { postComplaintToSlack } = await import('@/lib/complaints/slack-sender')
      const slack = await postComplaintToSlack({
        complaintId: id,
        contactId,
        personName: manual?.name ?? null,
        personPhone: manual?.phone ?? null,
        personEmail: manual?.email ?? null,
        title: input.title,
        description: input.description ?? null,
        category: input.category ?? null,
        severity: input.severity,
        agentId: user.id,
        requestId: ctx.requestId,
      }).catch((err): Awaited<ReturnType<typeof postComplaintToSlack>> => ({
        status: 'failed',
        channelName: null,
        detail: err instanceof Error ? err.message : String(err),
      }))
      if (slack.status === 'sent' && slack.slackTs && slack.channelId) {
        await ctx.db.complaint
          .update({
            where: { id },
            data: {
              slackChannelId: slack.channelId,
              slackMessageTs: slack.slackTs,
              slackChannelName: slack.channelName ?? null,
            },
          })
          .catch(() => undefined)
      }

      return {
        id,
        slack: {
          status: slack.status,
          // The REAL channel it landed in (or null when unknown) so the UI
          // never claims a hardcoded destination, plus any actionable detail.
          channelName: slack.channelName ?? null,
          detail: slack.detail ?? null,
        },
      }
    }),

  update: auditedProcedure
    .input(
      z.object({
        id: z.string(),
        status: StatusEnum.optional(),
        severity: SeverityEnum.optional(),
        category: z.string().trim().max(80).nullish(),
        assigneeId: z.string().nullish(),
        title: z.string().trim().min(2).max(200).optional(),
        description: z.string().trim().max(4000).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const existing = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true, status: true },
      })
      if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
      // Keep resolvedAt/resolvedById consistent with the status transition.
      let resolvedTransition: { resolvedAt?: Date | null; resolvedById?: string | null } = {}
      if (input.status !== undefined && input.status !== existing.status) {
        const wasTerminal = TERMINAL_STATUSES.has(existing.status)
        const willBeTerminal = TERMINAL_STATUSES.has(input.status)
        if (!wasTerminal && willBeTerminal) {
          resolvedTransition = { resolvedAt: new Date(), resolvedById: user.id }
        } else if (wasTerminal && !willBeTerminal) {
          resolvedTransition = { resolvedAt: null, resolvedById: null }
        }
      }
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.severity !== undefined ? { severity: input.severity } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...resolvedTransition,
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

  /** Add a thread message or action point. Logs onto the customer's CRM timeline
   *  (if linked) AND mirrors into the complaint's Slack thread. */
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
        select: { id: true, contactId: true, slackChannelId: true, slackMessageTs: true },
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
      await timelineNote(ctx.db, {
        contactId: c.contactId,
        summary: `${input.isActionPoint ? 'Complaint action' : 'Complaint update'}: ${input.body}`,
        event: 'complaint.update_added',
        complaintId: c.id,
        actorId: user.id,
      })
      await ctx.audit({
        action: 'complaint.update_added',
        target: { type: 'Complaint', id: input.complaintId },
        after: { updateId: id, isActionPoint: input.isActionPoint },
      })
      // Mirror into the Slack thread (best-effort).
      if (c.slackChannelId && c.slackMessageTs) {
        const author = await ctx.db.user.findUnique({
          where: { id: user.id },
          select: { name: true, email: true },
        })
        const { postComplaintThreadReply } = await import('@/lib/complaints/slack-sender')
        await postComplaintThreadReply({
          complaintId: c.id,
          updateId: id,
          channelId: c.slackChannelId,
          threadTs: c.slackMessageTs,
          body: input.body,
          isActionPoint: input.isActionPoint,
          authorName: author?.name?.trim() || author?.email || null,
          agentId: user.id,
          requestId: ctx.requestId,
        }).catch(() => undefined)
      }
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
      await ctx.audit({ action: 'complaint.reopened', target: { type: 'Complaint', id: input.id } })
      return { ok: true }
    }),

  /** Archive (hide from the active queue) — reversible, never deletes. */
  archive: auditedProcedure
    .input(z.object({ id: z.string(), archived: z.boolean().default(true) }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findFirst({
        where: { id: input.id, deletedAt: null },
        select: { id: true },
      })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: { archivedAt: input.archived ? new Date() : null, updatedById: user.id },
      })
      await ctx.audit({
        action: input.archived ? 'complaint.archived' : 'complaint.unarchived',
        target: { type: 'Complaint', id: input.id },
      })
      return { ok: true }
    }),

  /** Soft-delete (remove from the queue; recoverable). Any staff. */
  delete: auditedProcedure
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
        data: { deletedAt: new Date(), updatedById: user.id },
      })
      await ctx.audit({ action: 'complaint.deleted', target: { type: 'Complaint', id: input.id } })
      return { ok: true }
    }),

  /** Restore a soft-deleted complaint. Any staff. */
  restore: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      const c = await ctx.db.complaint.findUnique({
        where: { id: input.id },
        select: { id: true, deletedAt: true },
      })
      if (!c || !c.deletedAt) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.complaint.update({
        where: { id: input.id },
        data: { deletedAt: null, updatedById: user.id },
      })
      await ctx.audit({ action: 'complaint.restored', target: { type: 'Complaint', id: input.id } })
      return { ok: true }
    }),

  /** Permanently delete a complaint + its thread (irreversible). Any staff —
   *  guarded by a confirm dialog + audit row, not a role gate. */
  permanentlyDelete: auditedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      requireUser(ctx)
      const c = await ctx.db.complaint.findUnique({ where: { id: input.id }, select: { id: true } })
      if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
      // Audit BEFORE the row is gone so the deletion itself is recorded.
      await ctx.audit({
        action: 'complaint.purged',
        target: { type: 'Complaint', id: input.id },
      })
      // ComplaintUpdate rows cascade on the FK.
      await ctx.db.complaint.delete({ where: { id: input.id } })
      return { ok: true }
    }),
})
