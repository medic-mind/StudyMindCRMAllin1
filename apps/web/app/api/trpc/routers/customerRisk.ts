// Customer hours-risk dashboard data (CLAUDE.md §6.4 derived-state pattern).
//
// Surfaces customers whose booked tutoring hours are at risk of expiring
// unused (hours expire 12 months after booking). The risk itself is derived,
// never stored (deriveHoursRisk in @studymind/core/contact). This is a bounded
// scan over customers that actually hold a booked balance — not the whole
// contact table — so it stays cheap without cursor pagination.
//
// Lives on its own small router (not the large contact router) to keep tRPC
// client-type inference within budget. CLAUDE.md §27.

import { z } from 'zod'

import { deriveHoursRisk, type HoursRiskLevel } from '@studymind/core/contact'

import { protectedProcedure, router } from '@/lib/trpc/builders'

const LEVEL_RANK: Record<HoursRiskLevel, number> = { none: 0, low: 1, medium: 2, high: 3 }

export const customerRiskRouter = router({
  /**
   * Customers with a booked balance, scored for hours-expiry risk and returned
   * worst-first. Bounded by `limit`; the population is naturally small (only
   * customers with hours), so we score in memory rather than in SQL.
   */
  list: protectedProcedure
    .input(
      z
        .object({
          /** Minimum level to include. Defaults to `medium` (the actionable set). */
          minLevel: z.enum(['low', 'medium', 'high']).default('medium'),
          limit: z.number().int().min(1).max(500).default(200),
        })
        .default({ minLevel: 'medium', limit: 200 }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date()
      // Candidate population: not deleted, holds at least some booked hours.
      const rows = await ctx.db.contact.findMany({
        where: {
          deletedAt: null,
          hoursBooked: { gt: 0 },
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
          bookingProfile: {
            select: { hoursRemaining: true, nextHoursExpiryAt: true },
          },
          labels: {
            include: { label: { select: { id: true, name: true, color: true } } },
          },
        },
        // A safety cap on the scan; the real population is small.
        take: 5000,
      })

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
          }
        })
        .filter((r) => LEVEL_RANK[r.level] >= minRank)
        .sort((a, b) => {
          // Worst first: by level, then score, then soonest expiry.
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
        total: scored.length,
      }

      return { items: scored, counts }
    }),
})
