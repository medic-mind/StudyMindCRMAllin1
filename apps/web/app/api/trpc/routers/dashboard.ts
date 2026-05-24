// Dashboard router. Powers the home page (/). Returns a single round-trip
// payload with KPI tiles, recent activity, and at-risk families.
// CLAUDE.md §27 (tRPC conventions), §20 (RBAC).

import { z } from 'zod'

import {
  protectedProcedure,
  requireUser,
  router,
} from '@/lib/trpc/builders'

interface KpiValue {
  value: number
  delta: number | null
  label: string
}

interface ActivityRow {
  id: string
  action: string
  actorId: string | null
  actorEmail: string | null
  targetType: string
  targetId: string
  occurredAt: Date
  href: string | null
}

interface AtRiskFamilyRow {
  id: string
  name: string | null
  reasons: string[]
}

function targetHref(targetType: string, targetId: string): string | null {
  switch (targetType) {
    case 'Contact':
      return `/contacts/${targetId}`
    case 'Family':
      return `/contacts/families/${targetId}`
    case 'ReconciliationDiscrepancy':
      return `/finance`
    case 'Task':
      return `/tasks`
    case 'PaymentLinkIntent':
      return `/finance/payment-links`
    case 'RefundIntent':
      return `/finance/refunds`
    default:
      return null
  }
}

export const dashboardRouter = router({
  summary: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const user = requireUser(ctx)
      const now = new Date()
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      const tomorrow = new Date(now)
      tomorrow.setHours(0, 0, 0, 0)
      tomorrow.setDate(tomorrow.getDate() + 1)
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)

      // KPI 1: Active families
      const activeFamilies = await ctx.db.family.count({
        where: { state: { in: ['trial', 'active'] }, deletedAt: null },
      })
      const activeFamiliesPrev = await ctx.db.family.count({
        where: {
          state: { in: ['trial', 'active'] },
          deletedAt: null,
          createdAt: { lte: sevenDaysAgo },
        },
      })

      // KPI 2: Open discrepancies
      const openDiscrepancies = await ctx.db.reconciliationDiscrepancy.count({
        where: { resolvedAt: null },
      })
      const openDiscrepanciesPrev = await ctx.db.reconciliationDiscrepancy.count(
        {
          where: { resolvedAt: null, createdAt: { lte: sevenDaysAgo } },
        },
      )

      // KPI 3: Tasks due today (assigned to current user)
      const tasksDueToday = await ctx.db.task.count({
        where: {
          assigneeId: user.id,
          status: 'open',
          deletedAt: null,
          dueAt: { lt: tomorrow },
        },
      })

      // KPI 4: AI spend MTD. DriftSample is a 1% sample of production AI
      // calls; multiply by 100 to estimate true spend (same multiplier the
      // weekly cost-summary job uses). Round to whole dollars for the tile.
      const samples = await ctx.db.driftSample.aggregate({
        where: { sampledAt: { gte: monthStart } },
        _sum: { costUsd: true },
      })
      const sampledUsd = samples._sum.costUsd ?? 0
      const totalUsd = Math.round(sampledUsd * 100)
      const fourthTile: KpiValue = {
        value: totalUsd,
        delta: null,
        label: 'AI spend this month ($)',
      }

      // Recent activity: latest 10 audit log entries.
      const auditRows = await ctx.db.auditLogEntry.findMany({
        orderBy: { occurredAt: 'desc' },
        take: 10,
        select: {
          id: true,
          action: true,
          actorId: true,
          targetType: true,
          targetId: true,
          occurredAt: true,
        },
      })
      const actorIds = Array.from(
        new Set(auditRows.map((r) => r.actorId).filter((x): x is string => !!x)),
      )
      const actors =
        actorIds.length > 0
          ? await ctx.db.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, email: true },
            })
          : []
      const actorMap = new Map(actors.map((a) => [a.id, a.email] as const))
      const activity: ActivityRow[] = auditRows.map((r) => ({
        id: r.id,
        action: r.action,
        actorId: r.actorId,
        actorEmail: r.actorId ? actorMap.get(r.actorId) ?? null : null,
        targetType: r.targetType,
        targetId: r.targetId,
        occurredAt: r.occurredAt,
        href: targetHref(r.targetType, r.targetId),
      }))

      // At-risk families. We trust the persisted state.at_risk and surface
      // the most-likely reasons by inspecting recent signals.
      const atRiskFamilies = await ctx.db.family.findMany({
        where: { state: 'at_risk', deletedAt: null },
        orderBy: { updatedAt: 'desc' },
        take: 5,
        select: {
          id: true,
          name: true,
          subscriptions: {
            orderBy: { updatedAt: 'desc' },
            take: 1,
            select: { state: true, currentPeriodEnd: true },
          },
        },
      })
      const atRisk: AtRiskFamilyRow[] = atRiskFamilies.map((f) => {
        const reasons: string[] = []
        const sub = f.subscriptions[0]
        if (sub?.state === 'past_due') reasons.push('Stripe past due')
        if (sub?.state === 'unpaid') reasons.push('Stripe unpaid')
        if (reasons.length === 0) reasons.push('Risk signals detected')
        return { id: f.id, name: f.name, reasons }
      })

      return {
        kpis: {
          activeFamilies: {
            value: activeFamilies,
            delta: activeFamilies - activeFamiliesPrev,
            label: 'Active families',
          } satisfies KpiValue,
          openDiscrepancies: {
            value: openDiscrepancies,
            delta: openDiscrepancies - openDiscrepanciesPrev,
            label: 'Open discrepancies',
          } satisfies KpiValue,
          tasksDueToday: {
            value: tasksDueToday,
            delta: null,
            label: 'My tasks due today',
          } satisfies KpiValue,
          fourth: fourthTile,
        },
        activity,
        atRisk,
      }
    }),
})
