// Customer hours-risk dashboard (CLAUDE.md §6.4 derived-state pattern).
//
// Surfaces customers whose booked tutoring hours are at risk of expiring
// unused (hours expire 12 months after booking). The risk LEVEL is derived,
// never stored (deriveHoursRisk in @studymind/core/contact). What *is* stored
// is the human triage decision — `ContactRiskReview` (flag / dismiss) — so an
// acknowledgement survives re-derivation and the dashboard can hide handled
// rows. Staff can also spin up a follow-up Task straight from a row.
//
// Bounded scan over customers that actually hold a booked balance — not the
// whole contact table — so it stays cheap without cursor pagination. Lives on
// its own small router to keep tRPC client-type inference within budget.

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { deriveHoursRisk, type HoursRiskLevel } from '@studymind/core/contact'
import { loadContactComplaintCounts } from '@studymind/core/stats'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

const LEVEL_RANK: Record<HoursRiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 }

const APPLY_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertCanReview(role: UserRole): void {
  if (!APPLY_ROLES.has(role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only Sales Executive or above can triage at-risk customers',
    })
  }
}

export const customerRiskRouter = router({
  /**
   * Customers with a booked balance, scored for hours-expiry risk and returned
   * worst-first. `view` controls the triage lens:
   *   - `open`      (default) — at/above `minLevel`, NOT dismissed.
   *   - `flagged`   — only those a human has flagged (any level).
   *   - `dismissed` — only those dismissed.
   *   - `all`       — everything scored at/above `minLevel`.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          minLevel: z.enum(['low', 'medium', 'high']).default('medium'),
          view: z.enum(['open', 'flagged', 'dismissed', 'all']).default('open'),
          limit: z.number().int().min(1).max(500).default(300),
        })
        .default({ minLevel: 'medium', view: 'open', limit: 300 }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date()
      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          hoursBooked: { gt: 0 },
          // The flagged/dismissed lenses are anchored on the review row, so we
          // can scope the scan to them directly.
          ...(input.view === 'flagged' ? { riskReview: { status: 'flagged' } } : {}),
          ...(input.view === 'dismissed' ? { riskReview: { status: 'dismissed' } } : {}),
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          phoneE164: true,
          hoursBooked: true,
          hoursDelivered: true,
          lastLessonAt: true,
          bookingProfile: { select: { hoursRemaining: true, nextHoursExpiryAt: true } },
          labels: { include: { label: { select: { id: true, name: true, color: true } } } },
          riskReview: {
            select: { status: true, note: true, reviewedAt: true, reviewedById: true },
          },
        },
        take: 5000,
      })

      // Open-task counts for the scanned customers, in one grouped query
      // (Contact has no Task back-relation, so we count separately).
      const taskGroups =
        rows.length > 0
          ? await ctx.db.task.groupBy({
              by: ['contactId'],
              where: {
                contactId: { in: rows.map((r) => r.id) },
                deletedAt: null,
                status: { notIn: ['done', 'cancelled'] },
              },
              _count: { _all: true },
            })
          : []
      const openTaskByContact = new Map(
        taskGroups
          .filter((g): g is typeof g & { contactId: string } => g.contactId != null)
          .map((g) => [g.contactId, g._count._all]),
      )

      // Active complaints for the scanned customers (open | in_progress), so the
      // dashboard can surface "customer with hours at risk AND a live complaint".
      const complaintByContact = await loadContactComplaintCounts(
        ctx.db,
        rows.map((r) => r.id),
      )

      const minRank = LEVEL_RANK[input.minLevel]
      const scored = rows
        .map((r) => {
          const hoursRemaining =
            r.bookingProfile?.hoursRemaining != null
              ? r.bookingProfile.hoursRemaining.toNumber()
              : null
          const risk = deriveHoursRisk(
            {
              hoursBooked: r.hoursBooked,
              hoursDelivered: r.hoursDelivered,
              hoursRemaining,
              lastLessonAt: r.lastLessonAt,
              nextHoursExpiryAt: r.bookingProfile?.nextHoursExpiryAt ?? null,
            },
            now,
          )
          const name =
            [r.firstName, r.lastName].filter(Boolean).join(' ').trim() || 'Unnamed contact'
          return {
            id: r.id,
            name,
            email: r.email,
            phoneE164: r.phoneE164,
            hoursBooked: r.hoursBooked,
            hoursDelivered: r.hoursDelivered,
            hoursRemaining: risk.hoursRemaining,
            daysToExpiry: risk.daysToExpiry,
            level: risk.level,
            score: risk.score,
            reasons: risk.reasons.map((x) => x.label),
            labels: r.labels.map((l) => l.label),
            reviewStatus: (r.riskReview?.status as 'flagged' | 'dismissed' | undefined) ?? null,
            reviewNote: r.riskReview?.note ?? null,
            openTaskCount: openTaskByContact.get(r.id) ?? 0,
            complaintCount: complaintByContact.get(r.id) ?? 0,
          }
        })
        .filter((r) => {
          // Flagged customers stay visible even if their derived level dips
          // below the threshold (a human is actively watching them).
          const meetsLevel = LEVEL_RANK[r.level] >= minRank
          switch (input.view) {
            case 'flagged':
              return r.reviewStatus === 'flagged'
            case 'dismissed':
              return r.reviewStatus === 'dismissed'
            case 'all':
              return meetsLevel || r.reviewStatus === 'flagged'
            case 'open':
            default:
              return (meetsLevel || r.reviewStatus === 'flagged') && r.reviewStatus !== 'dismissed'
          }
        })
        .sort((a, b) => {
          // Flagged first, then by level, score, soonest expiry.
          const af = a.reviewStatus === 'flagged' ? 1 : 0
          const bf = b.reviewStatus === 'flagged' ? 1 : 0
          if (af !== bf) return bf - af
          if (LEVEL_RANK[b.level] !== LEVEL_RANK[a.level]) {
            return LEVEL_RANK[b.level] - LEVEL_RANK[a.level]
          }
          if (b.score !== a.score) return b.score - a.score
          const ax = a.daysToExpiry ?? Number.POSITIVE_INFINITY
          const bx = b.daysToExpiry ?? Number.POSITIVE_INFINITY
          return ax - bx
        })
        .slice(0, input.limit)

      const counts = {
        high: scored.filter((r) => r.level === 'high').length,
        medium: scored.filter((r) => r.level === 'medium').length,
        low: scored.filter((r) => r.level === 'low').length,
        flagged: scored.filter((r) => r.reviewStatus === 'flagged').length,
        total: scored.length,
      }

      return { items: scored, counts }
    }),

  /** Flag or dismiss a customer (upsert the triage row). Sales Executive+. */
  setReview: auditedProcedure
    .input(
      z.object({
        contactId: z.string(),
        status: z.enum(['flagged', 'dismissed']),
        note: z.string().trim().max(2000).optional(),
        levelAtReview: z.enum(['none', 'low', 'medium', 'high']).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanReview(user.role)
      const contact = await ctx.db.contact.findFirst({
        where: { id: input.contactId, deletedAt: null },
        select: { id: true },
      })
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND' })
      await ctx.db.contactRiskReview.upsert({
        where: { contactId: input.contactId },
        create: {
          contactId: input.contactId,
          status: input.status,
          note: input.note ?? null,
          levelAtReview: input.levelAtReview ?? null,
          reviewedById: user.id,
        },
        update: {
          status: input.status,
          note: input.note ?? null,
          levelAtReview: input.levelAtReview ?? null,
          reviewedById: user.id,
          reviewedAt: new Date(),
        },
      })
      await ctx.audit({
        action: input.status === 'flagged' ? 'contact.risk_flagged' : 'contact.risk_dismissed',
        target: { type: 'Contact', id: input.contactId },
        after: { status: input.status, note: input.note ?? null },
      })
      return { ok: true }
    }),

  /** Clear a triage decision (back to untriaged). Sales Executive+. */
  clearReview: auditedProcedure
    .input(z.object({ contactId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanReview(user.role)
      await ctx.db.contactRiskReview.deleteMany({ where: { contactId: input.contactId } })
      await ctx.audit({
        action: 'contact.risk_review_cleared',
        target: { type: 'Contact', id: input.contactId },
      })
      return { ok: true }
    }),

  /**
   * Create a follow-up Task against a customer straight from the dashboard
   * (e.g. "Chase unused hours before expiry"). Sales Executive+. Mirrors the
   * task router's create gating/validation but scoped to this workflow.
   */
  createTask: auditedProcedure
    .input(
      z.object({
        contactId: z.string(),
        title: z.string().trim().min(1).max(280),
        assigneeId: z.string().min(1),
        dueAt: z.date().optional(),
        note: z.string().trim().max(4000).optional(),
        /** Flag the customer at the same time (default true — they're a risk). */
        alsoFlag: z.boolean().default(true),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanReview(user.role)
      const [contact, assignee] = await Promise.all([
        ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        }),
        ctx.db.user.findFirst({
          where: { id: input.assigneeId, deletedAt: null, isActive: true },
          select: { id: true },
        }),
      ])
      if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'Contact not found' })
      if (!assignee) throw new TRPCError({ code: 'NOT_FOUND', message: 'Assignee not found' })

      const id = createId()
      await ctx.db.task.create({
        data: {
          id,
          title: input.title,
          description: input.note ?? null,
          status: 'open',
          assigneeId: assignee.id,
          contactId: contact.id,
          dueAt: input.dueAt ?? null,
          createdById: user.id,
          updatedById: user.id,
          lastWrittenBy: 'crm',
          lastWrittenAt: new Date(),
        },
      })
      await ctx.audit({
        action: 'task.created',
        target: { type: 'Task', id },
        after: { title: input.title, contactId: contact.id, source: 'at_risk_dashboard' },
      })

      if (input.alsoFlag) {
        await ctx.db.contactRiskReview.upsert({
          where: { contactId: contact.id },
          create: { contactId: contact.id, status: 'flagged', reviewedById: user.id },
          update: { status: 'flagged', reviewedById: user.id, reviewedAt: new Date() },
        })
        await ctx.audit({
          action: 'contact.risk_flagged',
          target: { type: 'Contact', id: contact.id },
          after: { via: 'task_created' },
        })
      }
      return { taskId: id }
    }),
})
