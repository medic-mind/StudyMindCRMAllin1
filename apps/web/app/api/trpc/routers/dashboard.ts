// Dashboard router. Powers the home page (/). One round-trip that paints a
// genuine "single pane of glass" for the whole CRM as it is today:
//   - four headline KPI tiles (role-aware),
//   - a "Needs attention" grid of action queues across every work surface
//     (Trengo, calls, leads, complaints, Slack, finance, Direct Debits, …),
//   - recent audited activity,
//   - the live at-risk-customers list (hours expiring unused — the current
//     retention concept, CLAUDE.md §6.4, replacing the deprecated at-risk
//     *families* derivation).
// CLAUDE.md §27 (tRPC conventions), §20 (RBAC), §3 (derived, never stored).

import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'

import {
  deriveMissedCalls,
  isAnswered,
  normalizeCalls,
  projectCallInteraction,
  summariseMissedCalls,
  type MissedCallReviewRow,
} from '@studymind/core/calls'
import { deriveHoursRisk, type HoursRiskLevel } from '@studymind/core/contact'
import { listUnresolvedStripePayments } from '@studymind/core/finance'

import {
  buildQueueCards,
  type QueueCard,
  type QueueCounts,
} from '@/lib/dashboard/queues'
import {
  protectedProcedure,
  requireUser,
  router,
  type UserRole,
} from '@/lib/trpc/builders'

type KpiTone = 'neutral' | 'success' | 'warn' | 'danger' | 'info'
type KpiIconKey = 'listTodo' | 'inbox' | 'alertTriangle' | 'users'

interface KpiTileData {
  key: string
  label: string
  value: number
  hint: string
  href: string
  tone: KpiTone
  icon: KpiIconKey
}

interface ActivityRow {
  id: string
  action: string
  actorEmail: string | null
  targetType: string
  targetId: string
  occurredAt: Date
  href: string | null
}

interface AtRiskCustomerRow {
  id: string
  name: string
  level: Exclude<HoursRiskLevel, 'none'>
  hoursRemaining: number
  daysToExpiry: number | null
  reason: string | null
}

const FINANCE_ROLES: ReadonlySet<UserRole> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

// Reconciliation discrepancy categories that belong to the Direct Debit
// operating system (ADR 0038) rather than the general finance backlog. We split
// them so each count deep-links to its own home (/direct-debits/issues vs
// /finance).
const DD_CATEGORIES = [
  'direct_debit_default',
  'direct_debit_plan_shortfall',
  'direct_debit_plan_arrears',
] as const

const LEVEL_RANK: Record<HoursRiskLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
}

function targetHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case 'Contact':
      return `/contacts/${targetId}`
    case 'Family':
      return `/contacts/families/${targetId}`
    case 'BusinessAccount':
      return `/accounts/${targetId}`
    case 'Conversation':
      return `/inbox/conversations/${targetId}`
    case 'Lead':
      return `/leads`
    case 'Complaint':
      return `/complaints`
    case 'Task':
      return `/tasks`
    case 'ReconciliationDiscrepancy':
      return `/finance`
    case 'PaymentLinkIntent':
      return `/finance/payment-links`
    case 'RefundIntent':
      return `/finance/refunds`
    default:
      return null
  }
}

/** Latest audited actions, with the actor email and a deep link resolved. */
async function loadRecentActivity(db: PrismaClient): Promise<ActivityRow[]> {
  const rows = await db.auditLogEntry.findMany({
    orderBy: { occurredAt: 'desc' },
    take: 12,
    select: {
      id: true,
      action: true,
      actorId: true,
      targetType: true,
      targetId: true,
      occurredAt: true,
    },
  })
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))]
  const actors = actorIds.length
    ? await db.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, email: true },
      })
    : []
  const emailById = new Map(actors.map((a) => [a.id, a.email] as const))
  return rows.map((r) => ({
    id: r.id,
    action: r.action,
    actorEmail: r.actorId ? emailById.get(r.actorId) ?? null : null,
    targetType: r.targetType,
    targetId: r.targetId,
    occurredAt: r.occurredAt,
    href: targetHref(r.targetType, r.targetId),
  }))
}

/**
 * Outstanding missed-call count over the same 30-day window the /calls
 * workspace uses, so the two never disagree. Reuses the shared core projection
 * + derivation (CLAUDE.md §3). Resilient: a slow/failed scan degrades to `null`
 * (the tile shows "—") rather than taking the whole dashboard down.
 */
async function loadMissedCallCount(db: PrismaClient, now: Date): Promise<number | null> {
  try {
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const rows = await db.interaction.findMany({
      where: { type: 'call', occurredAt: { gte: from, lte: now }, deletedAt: null },
      select: { id: true, occurredAt: true, contactId: true, payload: true },
      orderBy: { occurredAt: 'desc' },
      take: 20000,
    })
    const calls = normalizeCalls(rows.map(projectCallInteraction))
    const missedAircallIds = calls
      .filter((c) => c.direction === 'inbound' && !isAnswered(c) && c.aircallCallId)
      .map((c) => c.aircallCallId as string)
    const reviewRows = missedAircallIds.length
      ? await db.missedCallReview.findMany({
          where: { aircallCallId: { in: [...new Set(missedAircallIds)] } },
        })
      : []
    const reviews = new Map<string, MissedCallReviewRow>(
      reviewRows.map((r) => [
        r.aircallCallId,
        {
          status: r.status === 'dismissed' ? 'dismissed' : 'actioned',
          note: r.note,
          reviewedAt: r.reviewedAt,
          reviewedById: r.reviewedById,
        },
      ]),
    )
    return summariseMissedCalls(deriveMissedCalls(calls, reviews)).outstanding
  } catch {
    return null
  }
}

/**
 * The at-risk-hours customers: scored once, used for both the KPI count and the
 * top-5 panel. The level is derived, never stored (CLAUDE.md §6.4) — scanned
 * over the bounded set of customers that actually hold booked hours, and
 * resilient (returns `null` on failure → the tile shows "—").
 */
async function loadAtRiskCustomers(
  db: PrismaClient,
  now: Date,
): Promise<{ count: number; top: AtRiskCustomerRow[] } | null> {
  try {
    const rows = await db.contact.findMany({
      where: { deletedAt: null, hoursBooked: { gt: 0 } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        hoursBooked: true,
        hoursDelivered: true,
        lastLessonAt: true,
        bookingProfile: { select: { hoursRemaining: true, nextHoursExpiryAt: true } },
        riskReview: { select: { status: true } },
      },
      take: 5000,
    })
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
          level: risk.level,
          score: risk.score,
          hoursRemaining: risk.hoursRemaining,
          daysToExpiry: risk.daysToExpiry,
          reason: risk.reasons[0]?.label ?? null,
          dismissed: r.riskReview?.status === 'dismissed',
        }
      })
      // Medium+ and not actively dismissed by a human (CLAUDE.md §6.4 — the
      // human decision survives re-derivation).
      .filter((s) => LEVEL_RANK[s.level] >= LEVEL_RANK.medium && !s.dismissed)

    const top: AtRiskCustomerRow[] = [...scored]
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((s) => ({
        id: s.id,
        name: s.name,
        level: s.level as Exclude<HoursRiskLevel, 'none'>,
        hoursRemaining: s.hoursRemaining,
        daysToExpiry: s.daysToExpiry,
        reason: s.reason,
      }))
    return { count: scored.length, top }
  } catch {
    return null
  }
}

/** Count of successful Stripe charges not yet linked to a Family (ADR 0030). */
async function loadUnresolvedPaymentCount(db: PrismaClient): Promise<number> {
  try {
    return (await listUnresolvedStripePayments(db)).length
  } catch {
    return 0
  }
}

export const dashboardRouter = router({
  summary: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const user = requireUser(ctx)
      const db = ctx.db
      const role = user.role
      const isFinance = FINANCE_ROLES.has(role)
      const now = new Date()

      const [
        myOpenTasks,
        myOverdueTasks,
        unassignedConversations,
        customers,
        openComplaints,
        leadsToTriage,
        slackMentions,
        contactSuggestions,
        financeDiscrepancies,
        directDebitIssues,
        unresolvedPayments,
        activity,
        missedCalls,
        atRisk,
      ] = await Promise.all([
        db.task.count({
          where: { assigneeId: user.id, deletedAt: null, status: { notIn: ['done', 'cancelled'] } },
        }),
        db.task.count({
          where: {
            assigneeId: user.id,
            deletedAt: null,
            status: { notIn: ['done', 'cancelled'] },
            dueAt: { lt: now },
          },
        }),
        db.conversation.count({ where: { status: 'open', assigneeUserId: null } }),
        db.contact.count({ where: { deletedAt: null } }),
        db.complaint.count({ where: { deletedAt: null, status: { in: ['open', 'in_progress'] } } }),
        db.lead.count({ where: { deletedAt: null, status: 'needs_triage' } }),
        db.unassignedSummary.count({ where: { resolvedAt: null } }),
        db.contactFieldSuggestion.count({ where: { status: 'pending' } }),
        isFinance
          ? db.reconciliationDiscrepancy.count({
              where: { resolvedAt: null, category: { notIn: [...DD_CATEGORIES] } },
            })
          : Promise.resolve(0),
        isFinance
          ? db.reconciliationDiscrepancy.count({
              where: { resolvedAt: null, category: { in: [...DD_CATEGORIES] } },
            })
          : Promise.resolve(0),
        isFinance ? loadUnresolvedPaymentCount(db) : Promise.resolve(0),
        loadRecentActivity(db),
        loadMissedCallCount(db, now),
        loadAtRiskCustomers(db, now),
      ])

      const atRiskCount = atRisk?.count ?? 0

      const queueCounts: QueueCounts = {
        missedCalls: missedCalls ?? 0,
        leadsToTriage,
        openComplaints,
        slackMentions,
        contactSuggestions,
        financeDiscrepancies,
        directDebitIssues,
        unresolvedPayments,
      }
      const queues: QueueCard[] = buildQueueCards(queueCounts, role)

      const kpis: KpiTileData[] = [
        {
          key: 'tasks',
          label: 'My open tasks',
          value: myOpenTasks,
          hint: myOverdueTasks > 0 ? `${myOverdueTasks} overdue` : 'Assigned to you',
          href: '/tasks',
          tone: myOverdueTasks > 0 ? 'warn' : myOpenTasks > 0 ? 'info' : 'success',
          icon: 'listTodo',
        },
        {
          key: 'conversations',
          label: 'Unassigned conversations',
          value: unassignedConversations,
          hint: 'Trengo inbox',
          href: '/inbox',
          tone: unassignedConversations > 0 ? 'info' : 'success',
          icon: 'inbox',
        },
        {
          key: 'atRisk',
          label: 'At-risk customers',
          value: atRiskCount,
          hint: 'Hours expiring unused',
          href: '/contacts/at-risk',
          tone: atRiskCount > 0 ? 'warn' : 'success',
          icon: 'alertTriangle',
        },
        {
          key: 'customers',
          label: 'Customers',
          value: customers,
          hint: 'B2C contacts',
          href: '/contacts',
          tone: 'info',
          icon: 'users',
        },
      ]

      return {
        kpis,
        queues,
        activity,
        atRiskCustomers: atRisk?.top ?? [],
      }
    }),
})
