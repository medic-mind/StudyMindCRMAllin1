// Finance router. See CLAUDE.md §27 (tRPC conventions), §20 (RBAC),
// §6.3 (reconciliation triangle), §3 (never auto-resolve).

import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import { refundCharge, StripePaymentNotFoundError } from '@studymind/integration-stripe/outbound'

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
      'la_family_with_card_subscription',
      'other',
    ])
    .optional(),
  includeResolved: z.boolean().default(false),
})

const ResolveInput = z.object({
  id: z.string(),
  rationale: z.string().trim().min(3).max(2000),
})

// Refund procedures. CLAUDE.md §8: deterministic idempotency key, audit on
// success, never auto-retry. Role-gated to `admin | finance` per §20.1.

const RefundCreateInput = z.object({
  chargeId: z.string().trim().min(3).max(120),
  reasonCode: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9_:.-]+$/i, 'reasonCode must be alphanumeric/underscore'),
  amountMinor: z.number().int().positive().max(10_000_000).optional(),
})

const RefundListInput = z.object({
  familyId: z.string().optional(),
  cursor: z
    .object({ id: z.string(), createdAt: z.date() })
    .nullish(),
  limit: z.number().min(1).max(100).default(25),
})

export const financeRouter = router({
  refund: router({
    create: auditedProcedure.input(RefundCreateInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await refundCharge(ctx.db, {
          chargeId: input.chargeId,
          reasonCode: input.reasonCode,
          amountMinor: input.amountMinor,
          actorId: user.id,
          requestId: ctx.requestId,
        })
        // refundCharge writes its own AuditLogEntry on success. We still
        // call ctx.audit so the auditedProcedure middleware is satisfied
        // (CLAUDE.md §27). Both rows share the same request_id; consumers
        // dedupe on (action, target.id, request_id).
        await ctx.audit({
          action: 'charge.refund_requested',
          target: { type: 'RefundIntent', id: result.refundIntentId },
          after: {
            chargeId: input.chargeId,
            reasonCode: input.reasonCode,
            amountMinor: input.amountMinor ?? null,
            status: result.status,
          },
        })
        return result
      } catch (err) {
        if (err instanceof StripePaymentNotFoundError) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'unknown charge' })
        }
        throw err
      }
    }),

    list: protectedProcedure.input(RefundListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.refundIntent.findMany({
        where: {
          deletedAt: null,
          ...(input.familyId ? { payment: { familyId: input.familyId } } : {}),
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
          paymentId: true,
          amountMinor: true,
          reasonCode: true,
          status: true,
          externalId: true,
          createdAt: true,
          payment: { select: { id: true, familyId: true, externalId: true } },
        },
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          id: r.id,
          chargeId: r.payment.externalId,
          familyId: r.payment.familyId,
          amountMinor: r.amountMinor,
          reasonCode: r.reasonCode,
          status: r.status,
          stripeRefundId: r.externalId,
          createdAt: r.createdAt,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),
  }),

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
