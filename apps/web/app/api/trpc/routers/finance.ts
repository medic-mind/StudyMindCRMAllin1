// Finance router. See CLAUDE.md §27 (tRPC conventions), §20 (RBAC),
// §6.3 (reconciliation triangle), §3 (never auto-resolve).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import { z } from 'zod'

import {
  createPaymentLink,
  refundCharge,
  StripePaymentNotFoundError,
} from '@studymind/integration-stripe/outbound'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

// Refunds + allocation review + reconciliation are restricted to roles that
// can move money. ADR 0014 — ceo, senior_manager, manager. Sales Executive
// can create payment links (below) but never issues refunds.
const FINANCE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

// charge.create_link is allowed for everyone above virtual_assistant.
// ADR 0014 / CLAUDE.md §20.1.
const PAYMENT_LINK_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
])

function assertFinanceRole(user: SessionUser): void {
  if (!FINANCE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'finance role required' })
  }
}

function assertPaymentLinkRole(user: SessionUser): void {
  if (!PAYMENT_LINK_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'payment link role required' })
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

const PaymentLinkCreateInput = z.object({
  familyId: z.string().min(1),
  contactId: z.string().min(1).optional(),
  amountMinor: z.number().int().positive().max(10_000_000),
  currency: z
    .string()
    .trim()
    .min(3)
    .max(8)
    .regex(/^[a-z]+$/i, 'currency must be a 3-letter ISO code')
    .default('gbp'),
  reason: z.string().trim().min(2).max(120),
  productName: z.string().trim().min(2).max(120),
})

const PaymentLinkListInput = z.object({
  familyId: z.string().optional(),
  cursor: z.object({ id: z.string(), createdAt: z.date() }).nullish(),
  limit: z.number().min(1).max(100).default(25),
})

export const financeRouter = router({
  paymentLink: router({
    create: auditedProcedure.input(PaymentLinkCreateInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertPaymentLinkRole(user)

      // Sanity: family must exist and not be soft-deleted.
      const family = await ctx.db.family.findFirst({
        where: { id: input.familyId, deletedAt: null },
        select: { id: true },
      })
      if (!family) throw new TRPCError({ code: 'NOT_FOUND', message: 'family not found' })

      const result = await createPaymentLink(ctx.db, {
        familyId: input.familyId,
        contactId: input.contactId ?? null,
        agentId: user.id,
        amountMinor: input.amountMinor,
        currency: input.currency.toLowerCase(),
        reason: input.reason,
        productName: input.productName,
        requestId: ctx.requestId,
      })

      // createPaymentLink writes its own AuditLogEntry; satisfy the
      // auditedProcedure middleware too (CLAUDE.md §27).
      await ctx.audit({
        action: 'charge.payment_link_requested',
        target: { type: 'PaymentLinkIntent', id: result.paymentLinkIntentId },
        after: {
          familyId: input.familyId,
          contactId: input.contactId ?? null,
          amountMinor: input.amountMinor,
          currency: input.currency.toLowerCase(),
          reason: input.reason,
        },
      })

      return result
    }),

    list: protectedProcedure.input(PaymentLinkListInput).query(async ({ ctx, input }) => {
      assertPaymentLinkRole(requireUser(ctx))
      const rows = await ctx.db.paymentLinkIntent.findMany({
        where: {
          ...(input.familyId ? { familyId: input.familyId } : {}),
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
          contactId: true,
          agentId: true,
          amountMinor: true,
          currency: true,
          reason: true,
          stripePaymentLinkId: true,
          url: true,
          status: true,
          createdAt: true,
        },
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const last = sliced[sliced.length - 1]
      return {
        items: sliced,
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),
  }),

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

  allocation: router({
    /**
     * Manual override of payment-to-booking allocations. CLAUDE.md §6.3, §9.
     *
     * Replaces the active allocation set for a Payment with the provided
     * lines. Server-side asserts:
     *   sum(activeAllocations) <= Payment.amountMinor (CLAUDE.md §41.2).
     * Existing active rows that are not in `allocations` are soft-deleted;
     * (paymentId, bookingId) pairs are upserted (active rows updated in
     * place); brand-new pairs are created.
     */
    upsert: auditedProcedure
      .input(
        z.object({
          paymentId: z.string().min(1),
          allocations: z
            .array(
              z.object({
                bookingId: z.string().min(1),
                amountMinor: z.number().int().positive().max(10_000_000),
                reason: z.string().trim().min(2).max(500),
              }),
            )
            .min(0)
            .max(50),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)

        const payment = await ctx.db.payment.findUnique({
          where: { id: input.paymentId },
          select: { id: true, amountMinor: true, familyId: true },
        })
        if (!payment) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'payment not found' })
        }

        // §41.2 invariant: sum of active allocations cannot exceed Payment.
        const total = input.allocations.reduce((s, a) => s + a.amountMinor, 0)
        if (total > payment.amountMinor) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Allocations (${total}p) exceed Payment amount (${payment.amountMinor}p).`,
          })
        }

        const before = await ctx.db.allocation.findMany({
          where: { paymentId: input.paymentId, deletedAt: null },
          select: { id: true, bookingId: true, amountMinor: true, reason: true },
        })

        const incomingByBooking = new Map(input.allocations.map((a) => [a.bookingId, a]))

        const result = await ctx.db.$transaction(async (tx) => {
          // Soft-delete rows whose bookingId is no longer in the incoming set.
          const toRetire = before.filter((b) => !incomingByBooking.has(b.bookingId))
          for (const row of toRetire) {
            await tx.allocation.update({
              where: { id: row.id },
              data: { deletedAt: new Date(), updatedById: user.id },
            })
          }

          // Upsert each incoming row (active key is `(paymentId, bookingId)`
          // partial unique on deletedAt IS NULL).
          for (const a of input.allocations) {
            const existing = before.find((b) => b.bookingId === a.bookingId)
            if (existing) {
              await tx.allocation.update({
                where: { id: existing.id },
                data: {
                  amountMinor: a.amountMinor,
                  reason: a.reason,
                  updatedById: user.id,
                },
              })
            } else {
              await tx.allocation.create({
                data: {
                  id: createId(),
                  paymentId: input.paymentId,
                  bookingId: a.bookingId,
                  amountMinor: a.amountMinor,
                  reason: a.reason,
                  createdById: user.id,
                  updatedById: user.id,
                },
              })
            }
          }

          return tx.allocation.findMany({
            where: { paymentId: input.paymentId, deletedAt: null },
            select: { id: true, bookingId: true, amountMinor: true, reason: true },
          })
        })

        await ctx.audit({
          action: 'finance.allocation_upserted',
          target: { type: 'Payment', id: payment.id },
          before: { allocations: before },
          after: { allocations: result },
        })
        return { items: result }
      }),

    list: protectedProcedure
      .input(z.object({ paymentId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const rows = await ctx.db.allocation.findMany({
          where: { paymentId: input.paymentId, deletedAt: null },
          select: {
            id: true,
            bookingId: true,
            amountMinor: true,
            reason: true,
            createdAt: true,
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        })
        return { items: rows }
      }),

    delete: auditedProcedure
      .input(z.object({ allocationId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const before = await ctx.db.allocation.findUnique({
          where: { id: input.allocationId },
          select: {
            id: true,
            paymentId: true,
            bookingId: true,
            amountMinor: true,
            deletedAt: true,
          },
        })
        if (!before || before.deletedAt) {
          throw new TRPCError({ code: 'NOT_FOUND' })
        }
        const updated = await ctx.db.allocation.update({
          where: { id: before.id },
          data: { deletedAt: new Date(), updatedById: user.id },
        })
        await ctx.audit({
          action: 'finance.allocation_deleted',
          target: { type: 'Payment', id: before.paymentId },
          before,
          after: { id: updated.id, deletedAt: updated.deletedAt },
        })
        return { id: updated.id }
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
