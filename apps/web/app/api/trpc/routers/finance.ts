// Finance router. See CLAUDE.md §27 (tRPC conventions), §20 (RBAC),
// §6.3 (reconciliation triangle), §3 (never auto-resolve).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

const FINANCE_ROLES: ReadonlySet<SessionUser['role']> = new Set(['admin', 'finance'])

function assertFinanceRole(user: SessionUser): void {
  if (!FINANCE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'finance role required' })
  }
}

const ListInput = z.object({
  cursor: z
    .object({
      id: z.string(),
      createdAt: z.date(),
    })
    .nullish(),
  limit: z.number().min(1).max(100).default(50),
  category: z
    .enum([
      'hours_mismatch',
      'payment_unallocated',
      'late_failure',
      'late_failure_pending_action',
      'churned_with_active_subscription',
      'ap_review_overdue',
      'other',
    ])
    .optional(),
  includeResolved: z.boolean().default(false),
})

const ResolveInput = z.object({
  id: z.string(),
  rationale: z.string().trim().min(3).max(2000),
})

export const financeRouter = router({
  discrepancy: router({
    list: protectedProcedure.input(ListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.reconciliationDiscrepancy.findMany({
        where: {
          ...(input.includeResolved ? {} : { resolvedAt: null }),
          ...(input.category ? { category: input.category } : {}),
          family: {
            state: { in: ['trial', 'active', 'at_risk', 'churned'] },
            deletedAt: null,
          },
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
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          familyId: true,
          category: true,
          summary: true,
          payload: true,
          resolvedAt: true,
          createdAt: true,
          family: { select: { id: true, name: true, state: true } },
        },
      })

      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          id: r.id,
          familyId: r.familyId,
          familyName: r.family.name,
          familyState: r.family.state,
          category: r.category,
          summary: r.summary,
          payload: r.payload,
          createdAt: r.createdAt,
          resolvedAt: r.resolvedAt,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

    resolve: auditedProcedure.input(ResolveInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      const before = await ctx.db.reconciliationDiscrepancy.findUnique({
        where: { id: input.id },
      })
      if (!before) throw new TRPCError({ code: 'NOT_FOUND' })
      if (before.resolvedAt) {
        throw new TRPCError({ code: 'CONFLICT', message: 'already resolved' })
      }

      const after = await ctx.db.reconciliationDiscrepancy.update({
        where: { id: input.id },
        data: {
          resolvedAt: new Date(),
          resolvedById: user.id,
          payload: {
            ...((before.payload as Record<string, unknown>) ?? {}),
            resolutionRationale: input.rationale,
          },
          updatedById: user.id,
        },
      })

      await ctx.audit({
        action: 'finance.discrepancy_resolved',
        target: { type: 'Family', id: before.familyId },
        before,
        after: { id: after.id, rationale: input.rationale },
      })
      return { id: after.id }
    }),
  }),
})
