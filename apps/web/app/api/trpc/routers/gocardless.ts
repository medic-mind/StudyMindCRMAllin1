// GoCardless Direct Debit operating system (ADR 0038).
//
// Reads expose the complete provider mirror — every customer, mandate,
// subscription (all statuses, past included) and payment. Mutations are
// human-initiated money actions (CLAUDE.md §3 — never automatic): create a
// plan, cancel / pause / resume it, collect or cancel / retry a one-off
// payment, cancel a mandate, generate a hosted setup link. Everything is
// audited and idempotent on the request id.
//
// Roles (ADR 0014, §20.1): reads + money mutations are ceo / senior_manager /
// manager — consistent with finance.refund and subscription.cancel. The full
// historic import is ceo / senior_manager, matching the other admin backfills.

import { TRPCError } from '@trpc/server'
import type { GcPaymentState, GcSubscriptionState, Prisma } from '@prisma/client'
import { z } from 'zod'

import { BackfillAlreadyRunningError, startBackfill } from '@studymind/core/backfill'
import { linkGcCustomer } from '@studymind/core/finance'
import { GocardlessApiError } from '@studymind/integration-gocardless/client'
import {
  cancelMandateAction,
  cancelPendingPayment,
  cancelSubscriptionPlan,
  createHostedRedirectFlow,
  createOneOffPayment,
  createSubscriptionPlan,
  GcMandateNotFoundError,
  pauseSubscriptionPlan,
  resumeSubscriptionPlan,
  retryFailedPayment,
} from '@studymind/integration-gocardless/outbound'
import { inngest } from '@studymind/jobs'

import {
  auditedProcedure,
  protectedProcedure,
  requireUser,
  router,
  type SessionUser,
} from '@/lib/trpc/builders'

// Money-moving + financial-data roles (ADR 0014). Same set as finance.refund.
const FINANCE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

const IMPORT_ROLES: ReadonlySet<SessionUser['role']> = new Set(['ceo', 'senior_manager'])

function assertFinanceRole(user: SessionUser): void {
  if (!FINANCE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'finance role required' })
  }
}

/** Map a GoCardless API rejection onto our tRPC error vocabulary (§27). */
function rethrowGcError(err: unknown): never {
  if (err instanceof GcMandateNotFoundError) {
    throw new TRPCError({ code: 'NOT_FOUND', message: err.message })
  }
  if (err instanceof GocardlessApiError) {
    const message = extractGcMessage(err.body) ?? `GoCardless rejected the request (${err.status})`
    if (err.status === 404) throw new TRPCError({ code: 'NOT_FOUND', message })
    if (err.status === 409) throw new TRPCError({ code: 'CONFLICT', message })
    if (err.status >= 400 && err.status < 500) {
      throw new TRPCError({ code: 'BAD_REQUEST', message })
    }
  }
  throw err
}

function extractGcMessage(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null
  const error = (body as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const errors = (error as { errors?: unknown }).errors
  if (Array.isArray(errors)) {
    const parts = errors
      .map((e) => {
        if (typeof e !== 'object' || e === null) return null
        const field = (e as { field?: unknown }).field
        const message = (e as { message?: unknown }).message
        if (typeof message !== 'string') return null
        return typeof field === 'string' ? `${field} ${message}` : message
      })
      .filter((p): p is string => p !== null)
    if (parts.length > 0) return parts.join('; ')
  }
  const message = (error as { message?: unknown }).message
  return typeof message === 'string' ? message : null
}

// -----------------------------------------------------------------------------
// Shared view-model helpers
// -----------------------------------------------------------------------------

interface CustomerSummary {
  gcCustomerId: string
  displayName: string
  email: string | null
  contactId: string | null
  contactName: string | null
  familyId: string | null
}

/** Batch-load customer summaries (with linked contact names) for a page. */
async function loadCustomerSummaries(
  db: Prisma.TransactionClient | import('@prisma/client').PrismaClient,
  gcCustomerIds: string[],
): Promise<Map<string, CustomerSummary>> {
  const unique = Array.from(new Set(gcCustomerIds.filter((id) => id.length > 0)))
  if (unique.length === 0) return new Map()
  const rows = await db.gcCustomer.findMany({
    where: { gcCustomerId: { in: unique } },
    select: {
      gcCustomerId: true,
      email: true,
      givenName: true,
      familyName: true,
      companyName: true,
      contactId: true,
      familyId: true,
      contact: { select: { firstName: true, lastName: true } },
    },
  })
  const map = new Map<string, CustomerSummary>()
  for (const row of rows) {
    const name =
      [row.givenName, row.familyName].filter(Boolean).join(' ') ||
      row.companyName ||
      row.email ||
      row.gcCustomerId
    const contactName = row.contact
      ? [row.contact.firstName, row.contact.lastName].filter(Boolean).join(' ') || null
      : null
    map.set(row.gcCustomerId, {
      gcCustomerId: row.gcCustomerId,
      displayName: name,
      email: row.email,
      contactId: row.contactId,
      contactName,
      familyId: row.familyId,
    })
  }
  return map
}

const Cursor = z.object({ id: z.string(), createdAt: z.date() }).nullish()

function cursorWhere(cursor: { id: string; createdAt: Date } | null | undefined) {
  if (!cursor) return {}
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
    ],
  }
}

const SUBSCRIPTION_STATUSES = [
  'pending_customer_approval',
  'customer_approval_denied',
  'active',
  'finished',
  'cancelled',
  'paused',
  'unknown',
] as const

const PAYMENT_STATUSES = [
  'pending_customer_approval',
  'pending_submission',
  'submitted',
  'confirmed',
  'paid_out',
  'cancelled',
  'customer_approval_denied',
  'failed',
  'charged_back',
  'unknown',
] as const

// -----------------------------------------------------------------------------
// Input schemas
// -----------------------------------------------------------------------------

const SubscriptionListInput = z.object({
  status: z.enum([...SUBSCRIPTION_STATUSES, 'all']).default('all'),
  gcCustomerId: z.string().optional(),
  cursor: Cursor,
  limit: z.number().min(1).max(100).default(50),
})

const SubscriptionCreateInput = z.object({
  gcMandateId: z.string().min(3).max(120),
  amountMinor: z.number().int().positive().max(10_000_000),
  intervalUnit: z.enum(['weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(12).default(1),
  // GoCardless: 1–28, or -1 for the last day of the month.
  dayOfMonth: z
    .number()
    .int()
    .refine((v) => v === -1 || (v >= 1 && v <= 28), 'dayOfMonth must be 1–28 or -1')
    .optional(),
  name: z.string().trim().min(2).max(255).optional(),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'startDate must be YYYY-MM-DD')
    .optional(),
  count: z.number().int().min(1).max(520).optional(),
})

const SubscriptionActionInput = z.object({
  gcSubscriptionId: z.string().min(3).max(120),
  reason: z.string().trim().min(2).max(500).optional(),
})

const PaymentListInput = z.object({
  status: z.enum([...PAYMENT_STATUSES, 'all']).default('all'),
  gcCustomerId: z.string().optional(),
  gcSubscriptionId: z.string().optional(),
  cursor: Cursor,
  limit: z.number().min(1).max(100).default(50),
})

const PaymentCreateInput = z.object({
  gcMandateId: z.string().min(3).max(120),
  amountMinor: z.number().int().positive().max(10_000_000),
  description: z.string().trim().min(2).max(255).optional(),
  chargeDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'chargeDate must be YYYY-MM-DD')
    .optional(),
})

const PaymentActionInput = z.object({
  gcPaymentId: z.string().min(3).max(120),
  reason: z.string().trim().min(2).max(500).optional(),
})

const CustomerListInput = z.object({
  q: z.string().trim().max(120).optional(),
  link: z.enum(['all', 'linked', 'unlinked']).default('all'),
  cursor: Cursor,
  limit: z.number().min(1).max(100).default(50),
})

const MandateListInput = z.object({
  gcCustomerId: z.string().optional(),
  chargeableOnly: z.boolean().default(false),
  q: z.string().trim().max(120).optional(),
  cursor: Cursor,
  limit: z.number().min(1).max(100).default(50),
})

// Mandate states a plan/payment can be raised against.
const CHARGEABLE_MANDATE_STATES = ['pending_submission', 'submitted', 'active'] as const

export const gocardlessRouter = router({
  overview: protectedProcedure.query(async ({ ctx }) => {
    assertFinanceRole(requireUser(ctx))
    const [subsByStatus, customerTotal, customerUnlinked, mandateActive, collected] =
      await Promise.all([
        ctx.db.gcSubscription.groupBy({
          by: ['status'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        ctx.db.gcCustomer.count({ where: { deletedAt: null } }),
        ctx.db.gcCustomer.count({ where: { deletedAt: null, contactId: null } }),
        ctx.db.gcMandate.count({ where: { deletedAt: null, state: 'active' } }),
        ctx.db.gcPayment.aggregate({
          where: { deletedAt: null, status: { in: ['confirmed', 'paid_out'] } },
          _sum: { amountMinor: true },
          _count: { _all: true },
        }),
      ])

    const subscriptions: Record<string, number> = {}
    for (const row of subsByStatus) {
      subscriptions[row.status] = row._count._all
    }
    return {
      subscriptions,
      customers: { total: customerTotal, unlinked: customerUnlinked },
      activeMandates: mandateActive,
      collected: {
        totalMinor: collected._sum.amountMinor ?? 0,
        count: collected._count._all,
      },
    }
  }),

  customers: router({
    list: protectedProcedure.input(CustomerListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.gcCustomer.findMany({
        where: {
          deletedAt: null,
          ...(input.link === 'linked' ? { contactId: { not: null } } : {}),
          ...(input.link === 'unlinked' ? { contactId: null } : {}),
          ...(input.q
            ? {
                OR: [
                  { email: { contains: input.q, mode: 'insensitive' } },
                  { givenName: { contains: input.q, mode: 'insensitive' } },
                  { familyName: { contains: input.q, mode: 'insensitive' } },
                  { companyName: { contains: input.q, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...cursorWhere(input.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          gcCustomerId: true,
          email: true,
          givenName: true,
          familyName: true,
          companyName: true,
          contactId: true,
          familyId: true,
          gcCreatedAt: true,
          createdAt: true,
          contact: { select: { firstName: true, lastName: true } },
        },
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows

      // Per-page rollups so the table can show what each customer carries.
      const ids = sliced.map((r) => r.gcCustomerId)
      const [mandateCounts, subCounts] = await Promise.all([
        ctx.db.gcMandate.groupBy({
          by: ['gcCustomerId'],
          where: { gcCustomerId: { in: ids }, deletedAt: null },
          _count: { _all: true },
        }),
        ctx.db.gcSubscription.groupBy({
          by: ['gcCustomerId'],
          where: { gcCustomerId: { in: ids }, deletedAt: null, status: 'active' },
          _count: { _all: true },
        }),
      ])
      const mandatesBy = new Map(mandateCounts.map((m) => [m.gcCustomerId, m._count._all]))
      const subsBy = new Map(subCounts.map((s) => [s.gcCustomerId, s._count._all]))

      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          gcCustomerId: r.gcCustomerId,
          email: r.email,
          name:
            [r.givenName, r.familyName].filter(Boolean).join(' ') || r.companyName || null,
          contactId: r.contactId,
          contactName: r.contact
            ? [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') || null
            : null,
          familyId: r.familyId,
          mandateCount: mandatesBy.get(r.gcCustomerId) ?? 0,
          activeSubscriptionCount: subsBy.get(r.gcCustomerId) ?? 0,
          gcCreatedAt: r.gcCreatedAt,
          createdAt: r.createdAt,
          id: r.id,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

    link: auditedProcedure
      .input(
        z.object({
          gcCustomerId: z.string().min(3).max(120),
          contactId: z.string().min(1).nullable(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const result = await linkGcCustomer(ctx.db, {
          gcCustomerId: input.gcCustomerId,
          contactId: input.contactId,
        })
        if (!result.ok) {
          throw new TRPCError({ code: 'NOT_FOUND', message: result.reason })
        }
        await ctx.audit({
          action: input.contactId
            ? 'gocardless.customer.linked'
            : 'gocardless.customer.unlinked',
          target: { type: 'GcCustomer', id: input.gcCustomerId },
          after: {
            contactId: result.contactId ?? null,
            familyId: result.familyId ?? null,
            linkedMandates: result.linkedMandates ?? 0,
          },
        })
        return result
      }),
  }),

  mandates: router({
    list: protectedProcedure.input(MandateListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.gcMandate.findMany({
        where: {
          deletedAt: null,
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(input.chargeableOnly ? { state: { in: [...CHARGEABLE_MANDATE_STATES] } } : {}),
          ...(input.q
            ? {
                OR: [
                  { gcMandateId: { contains: input.q, mode: 'insensitive' } },
                  { reference: { contains: input.q, mode: 'insensitive' } },
                ],
              }
            : {}),
          ...cursorWhere(input.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
        select: {
          id: true,
          gcMandateId: true,
          state: true,
          gcCustomerId: true,
          reference: true,
          scheme: true,
          nextPossibleChargeDate: true,
          familyId: true,
          gcCreatedAt: true,
          createdAt: true,
        },
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const customers = await loadCustomerSummaries(
        ctx.db,
        sliced.map((r) => r.gcCustomerId ?? ''),
      )
      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          gcMandateId: r.gcMandateId,
          state: r.state,
          reference: r.reference,
          scheme: r.scheme,
          nextPossibleChargeDate: r.nextPossibleChargeDate,
          familyId: r.familyId,
          gcCreatedAt: r.gcCreatedAt,
          customer: r.gcCustomerId ? (customers.get(r.gcCustomerId) ?? null) : null,
          id: r.id,
          createdAt: r.createdAt,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

    cancel: auditedProcedure
      .input(
        z.object({
          gcMandateId: z.string().min(3).max(120),
          reason: z.string().trim().min(2).max(500),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        try {
          const result = await cancelMandateAction(ctx.db, {
            gcMandateId: input.gcMandateId,
            reason: input.reason,
            actorId: user.id,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'gocardless.mandate.cancel_requested',
            target: { type: 'GcMandate', id: input.gcMandateId },
            after: { state: result.state, reason: input.reason },
          })
          return result
        } catch (err) {
          rethrowGcError(err)
        }
      }),

    createSetupLink: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          description: z.string().trim().min(2).max(255).optional(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true },
        })
        if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'contact not found' })

        const member = await ctx.db.familyMember.findFirst({
          where: { contactId: input.contactId, family: { deletedAt: null } },
          select: { familyId: true },
          orderBy: { createdAt: 'asc' },
        })
        if (!member) {
          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'This contact does not belong to a family yet. Billing is family-keyed — add them to a family first, then generate the setup link.',
          })
        }

        const appUrl = (
          process.env['NEXT_PUBLIC_APP_URL'] ?? 'http://localhost:3000'
        ).replace(/\/$/, '')

        try {
          const result = await createHostedRedirectFlow(ctx.db, {
            familyId: member.familyId,
            billingContactId: input.contactId,
            redirectUrl: `${appUrl}/api/gocardless/redirect-flow/complete`,
            description: input.description ?? 'StudyMind Direct Debit',
            // Fresh flow per click — hosted flows expire after ~30 minutes.
            sessionKey: ctx.requestId,
            actorId: user.id,
            requestId: ctx.requestId,
          })
          await ctx.audit({
            action: 'gocardless.setup_link.created',
            target: { type: 'Contact', id: input.contactId },
            after: {
              familyId: member.familyId,
              mandateIntentId: result.mandateIntentId,
              status: result.status,
            },
          })
          if (result.status !== 'succeeded' || !result.redirectUrl) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: 'GoCardless did not return a setup link',
            })
          }
          return { url: result.redirectUrl, mandateIntentId: result.mandateIntentId }
        } catch (err) {
          rethrowGcError(err)
        }
      }),
  }),

  subscriptions: router({
    list: protectedProcedure.input(SubscriptionListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.gcSubscription.findMany({
        where: {
          deletedAt: null,
          ...(input.status !== 'all' ? { status: input.status as GcSubscriptionState } : {}),
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...cursorWhere(input.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const customers = await loadCustomerSummaries(
        ctx.db,
        sliced.map((r) => r.gcCustomerId ?? ''),
      )
      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          gcSubscriptionId: r.gcSubscriptionId,
          name: r.name,
          status: r.status,
          amountMinor: r.amountMinor,
          currency: r.currency,
          intervalUnit: r.intervalUnit,
          interval: r.interval,
          dayOfMonth: r.dayOfMonth,
          startDate: r.startDate,
          endDate: r.endDate,
          nextChargeAt: r.nextChargeAt,
          nextChargeMinor: r.nextChargeMinor,
          gcMandateId: r.gcMandateId,
          gcCreatedAt: r.gcCreatedAt,
          customer: r.gcCustomerId ? (customers.get(r.gcCustomerId) ?? null) : null,
          id: r.id,
          createdAt: r.createdAt,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

    create: auditedProcedure.input(SubscriptionCreateInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await createSubscriptionPlan(ctx.db, {
          gcMandateId: input.gcMandateId,
          amountMinor: input.amountMinor,
          intervalUnit: input.intervalUnit,
          interval: input.interval,
          ...(input.dayOfMonth !== undefined ? { dayOfMonth: input.dayOfMonth } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.startDate !== undefined ? { startDate: input.startDate } : {}),
          ...(input.count !== undefined ? { count: input.count } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.subscription.create_requested',
          target: { type: 'GcSubscription', id: result.gcSubscriptionId },
          after: {
            gcMandateId: input.gcMandateId,
            amountMinor: input.amountMinor,
            intervalUnit: input.intervalUnit,
            interval: input.interval,
            dayOfMonth: input.dayOfMonth ?? null,
            name: input.name ?? null,
          },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),

    cancel: auditedProcedure.input(SubscriptionActionInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await cancelSubscriptionPlan(ctx.db, {
          gcSubscriptionId: input.gcSubscriptionId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.subscription.cancel_requested',
          target: { type: 'GcSubscription', id: input.gcSubscriptionId },
          after: { status: result.status, reason: input.reason ?? null },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),

    pause: auditedProcedure.input(SubscriptionActionInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await pauseSubscriptionPlan(ctx.db, {
          gcSubscriptionId: input.gcSubscriptionId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.subscription.pause_requested',
          target: { type: 'GcSubscription', id: input.gcSubscriptionId },
          after: { status: result.status, reason: input.reason ?? null },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),

    resume: auditedProcedure.input(SubscriptionActionInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await resumeSubscriptionPlan(ctx.db, {
          gcSubscriptionId: input.gcSubscriptionId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.subscription.resume_requested',
          target: { type: 'GcSubscription', id: input.gcSubscriptionId },
          after: { status: result.status, reason: input.reason ?? null },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),
  }),

  payments: router({
    list: protectedProcedure.input(PaymentListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const rows = await ctx.db.gcPayment.findMany({
        where: {
          deletedAt: null,
          ...(input.status !== 'all' ? { status: input.status as GcPaymentState } : {}),
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(input.gcSubscriptionId ? { gcSubscriptionId: input.gcSubscriptionId } : {}),
          ...cursorWhere(input.cursor),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: input.limit + 1,
      })
      const hasMore = rows.length > input.limit
      const sliced = hasMore ? rows.slice(0, input.limit) : rows
      const customers = await loadCustomerSummaries(
        ctx.db,
        sliced.map((r) => r.gcCustomerId ?? ''),
      )
      const last = sliced[sliced.length - 1]
      return {
        items: sliced.map((r) => ({
          gcPaymentId: r.gcPaymentId,
          status: r.status,
          amountMinor: r.amountMinor,
          currency: r.currency,
          description: r.description,
          chargeDate: r.chargeDate,
          gcSubscriptionId: r.gcSubscriptionId,
          gcMandateId: r.gcMandateId,
          gcCreatedAt: r.gcCreatedAt,
          customer: r.gcCustomerId ? (customers.get(r.gcCustomerId) ?? null) : null,
          id: r.id,
          createdAt: r.createdAt,
        })),
        nextCursor: hasMore && last ? { id: last.id, createdAt: last.createdAt } : null,
      }
    }),

    create: auditedProcedure.input(PaymentCreateInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await createOneOffPayment(ctx.db, {
          gcMandateId: input.gcMandateId,
          amountMinor: input.amountMinor,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.chargeDate !== undefined ? { chargeDate: input.chargeDate } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.payment.create_requested',
          target: { type: 'GcPayment', id: result.gcPaymentId },
          after: {
            gcMandateId: input.gcMandateId,
            amountMinor: input.amountMinor,
            chargeDate: input.chargeDate ?? null,
            description: input.description ?? null,
          },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),

    cancel: auditedProcedure.input(PaymentActionInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await cancelPendingPayment(ctx.db, {
          gcPaymentId: input.gcPaymentId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.payment.cancel_requested',
          target: { type: 'GcPayment', id: input.gcPaymentId },
          after: { status: result.status, reason: input.reason ?? null },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),

    retry: auditedProcedure.input(PaymentActionInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertFinanceRole(user)
      try {
        const result = await retryFailedPayment(ctx.db, {
          gcPaymentId: input.gcPaymentId,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          actorId: user.id,
          requestId: ctx.requestId,
        })
        await ctx.audit({
          action: 'gocardless.payment.retry_requested',
          target: { type: 'GcPayment', id: input.gcPaymentId },
          after: { status: result.status, reason: input.reason ?? null },
        })
        return result
      } catch (err) {
        rethrowGcError(err)
      }
    }),
  }),

  import: router({
    /** Latest historic-import job, for the workspace banner. */
    status: protectedProcedure.query(async ({ ctx }) => {
      assertFinanceRole(requireUser(ctx))
      const job = await ctx.db.backfillJob.findFirst({
        where: { provider: 'gocardless' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          processedCount: true,
          matchedCount: true,
          skippedCount: true,
          error: true,
          createdAt: true,
          completedAt: true,
        },
      })
      return { job }
    }),

    /** Import the full Direct Debit history (CEO + Senior Manager). */
    start: auditedProcedure.mutation(async ({ ctx }) => {
      const user = requireUser(ctx)
      if (!IMPORT_ROLES.has(user.role)) throw new TRPCError({ code: 'FORBIDDEN' })
      try {
        const res = await startBackfill(ctx.db, inngest, {
          provider: 'gocardless',
          // The import walks everything regardless; the window is recorded
          // for the audit trail (≈10 years).
          windowDays: 3650,
          ctx: { actorId: user.id, requestId: ctx.requestId },
        })
        await ctx.audit({
          action: 'gocardless.import.started',
          target: { type: 'BackfillJob', id: res.jobId },
          after: { provider: 'gocardless' },
        })
        return res
      } catch (err) {
        if (err instanceof BackfillAlreadyRunningError) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'A GoCardless import is already running.',
          })
        }
        throw err
      }
    }),
  }),
})
