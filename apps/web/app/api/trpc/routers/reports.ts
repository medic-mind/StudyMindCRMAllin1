// Reports router. Read-only summaries for the Reports surface.
// CLAUDE.md §27. Role-gated: admin | ops_manager | finance.

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const REPORT_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'admin',
  'ops_manager',
  'finance',
])

function assertReports(user: SessionUser): void {
  if (!REPORT_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN' })
  }
}

const PeriodInput = z.object({
  from: z.coerce.date(),
  to: z.coerce.date(),
})

export const reportsRouter = router({
  finance: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const [openDiscrepancies, payments] = await Promise.all([
          ctx.db.reconciliationDiscrepancy.groupBy({
            by: ['category'],
            where: { resolvedAt: null },
            _count: { id: true },
          }),
          ctx.db.payment.findMany({
            where: {
              receivedAt: { gte: input.from, lte: input.to },
              deletedAt: null,
            },
            select: {
              amountMinor: true,
              provider: true,
              reverted: true,
            },
          }),
        ])

        const moneyInMinor = payments
          .filter((p) => !p.reverted)
          .reduce((acc, p) => acc + p.amountMinor, 0)
        const revertedMinor = payments
          .filter((p) => p.reverted)
          .reduce((acc, p) => acc + p.amountMinor, 0)

        const byProvider: Record<string, number> = {}
        for (const p of payments) {
          if (p.reverted) continue
          byProvider[p.provider] = (byProvider[p.provider] ?? 0) + p.amountMinor
        }

        // Reconciliation lag percentile — time between Payment.receivedAt and
        // its first Allocation (when no allocation yet, treat as ongoing and
        // exclude). Cheap to compute on the read side; for production scale
        // this would be precomputed nightly.
        const recent = await ctx.db.payment.findMany({
          where: {
            receivedAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            receivedAt: true,
            allocations: {
              select: { createdAt: true },
              orderBy: { createdAt: 'asc' },
              take: 1,
            },
          },
          take: 500,
        })
        const lagsSec = recent
          .map((p) => {
            const alloc = p.allocations[0]
            if (!alloc) return null
            return Math.max(0, (alloc.createdAt.getTime() - p.receivedAt.getTime()) / 1000)
          })
          .filter((x): x is number => x !== null)
          .sort((a, b) => a - b)
        const p50 = lagsSec[Math.floor(lagsSec.length * 0.5)] ?? null
        const p90 = lagsSec[Math.floor(lagsSec.length * 0.9)] ?? null

        return {
          period: { from: input.from, to: input.to },
          openDiscrepancies: openDiscrepancies.map((d) => ({
            category: d.category as string,
            count: d._count.id,
          })),
          moneyInMinor,
          revertedMinor,
          byProviderMinor: byProvider,
          reconciliationLag: {
            p50Sec: p50,
            p90Sec: p90,
            sampleSize: lagsSec.length,
          },
        }
      }),
  }),

  operations: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const sessions = await ctx.db.bookingSession.findMany({
          where: {
            scheduledAt: { gte: input.from, lte: input.to },
            deletedAt: null,
          },
          select: {
            state: true,
            scheduledHours: true,
            deliveredHours: true,
          },
          take: 5000,
        })

        const totals = {
          scheduled: 0,
          delivered: 0,
          noShow: 0,
          cancelled: 0,
          confirmed: 0,
          tentative: 0,
        }
        let scheduledHours = 0
        let deliveredHours = 0
        for (const s of sessions) {
          scheduledHours += s.scheduledHours
          deliveredHours += s.deliveredHours
          switch (s.state) {
            case 'delivered':
              totals.delivered += 1
              break
            case 'no_show':
              totals.noShow += 1
              break
            case 'cancelled':
              totals.cancelled += 1
              break
            case 'confirmed':
              totals.confirmed += 1
              break
            case 'tentative':
              totals.tentative += 1
              break
          }
          totals.scheduled += 1
        }

        const missedRate =
          totals.scheduled === 0
            ? 0
            : (totals.noShow + totals.cancelled) / totals.scheduled

        return {
          period: { from: input.from, to: input.to },
          sessionsByState: totals,
          scheduledHours,
          deliveredHours,
          missedSessionRate: missedRate,
        }
      }),
  }),

  retention: router({
    summary: protectedProcedure
      .input(PeriodInput)
      .query(async ({ ctx, input }) => {
        assertReports(requireUser(ctx))

        const [families, churnScores, churnedThisPeriod] = await Promise.all([
          ctx.db.family.groupBy({
            by: ['state'],
            where: { deletedAt: null },
            _count: { id: true },
          }),
          ctx.db.churnScore.findMany({
            where: {
              scoredAt: { gte: input.from, lte: input.to },
            },
            orderBy: { scoredAt: 'desc' },
            select: { score: true, familyId: true, scoredAt: true },
            take: 1000,
          }),
          ctx.db.interaction.count({
            where: {
              type: 'family_state_changed',
              occurredAt: { gte: input.from, lte: input.to },
            },
          }),
        ])

        // Bucket churn scores into deciles for a simple histogram.
        const buckets = new Array(10).fill(0) as number[]
        for (const s of churnScores) {
          const idx = Math.min(9, Math.max(0, Math.floor(s.score * 10)))
          buckets[idx] = (buckets[idx] ?? 0) + 1
        }

        return {
          period: { from: input.from, to: input.to },
          familiesByState: families.map((f) => ({
            state: f.state as string,
            count: f._count.id,
          })),
          churnScoreHistogram: buckets,
          churnScoreSamples: churnScores.length,
          churnEventsInPeriod: churnedThisPeriod,
        }
      }),
  }),
})
