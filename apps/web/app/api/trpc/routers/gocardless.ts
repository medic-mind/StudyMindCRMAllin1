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
import {
  createMandateSetupLink,
  linkGcCustomer,
  monthlyRunRateMinor,
  revokeSetupLink,
} from '@studymind/core/finance'
import { GocardlessApiError } from '@studymind/integration-gocardless/client'
import {
  cancelMandateAction,
  cancelPendingPayment,
  cancelSubscriptionPlan,
  createOneOffPayment,
  createSubscriptionPlan,
  GcMandateNotFoundError,
  pauseSubscriptionPlan,
  resumeSubscriptionPlan,
  retryFailedPayment,
} from '@studymind/integration-gocardless/outbound'
import { inngest } from '@studymind/jobs'

import { buildSetupLinkUrl, sendSetupLinkEmail } from '@/lib/gocardless/setup-link-email'
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

/**
 * Resolve a free-text customer search to the matching GoCardless customer
 * ids, so the plans/payments lists can filter by customer the way the
 * GoCardless dashboard does. Returns null when no query was given (no
 * filter); an empty array means "matches nothing".
 */
async function resolveCustomerIdsForQuery(
  db: Prisma.TransactionClient | import('@prisma/client').PrismaClient,
  q: string | undefined,
): Promise<string[] | null> {
  const trimmed = q?.trim()
  if (!trimmed || trimmed.length < 2) return null
  const rows = await db.gcCustomer.findMany({
    where: {
      deletedAt: null,
      OR: [
        { email: { contains: trimmed, mode: 'insensitive' } },
        { givenName: { contains: trimmed, mode: 'insensitive' } },
        { familyName: { contains: trimmed, mode: 'insensitive' } },
        { companyName: { contains: trimmed, mode: 'insensitive' } },
        { gcCustomerId: { equals: trimmed } },
      ],
    },
    select: { gcCustomerId: true },
    take: 200,
  })
  return rows.map((r) => r.gcCustomerId)
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
  /** Customer search — matches the GoCardless dashboard's list search. */
  q: z.string().trim().max(120).optional(),
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
  /** Customer search — matches the GoCardless dashboard's list search. */
  q: z.string().trim().max(120).optional(),
  cursor: Cursor,
  limit: z.number().min(1).max(100).default(50),
})

/** Shared input for the per-status count strips above the list tables. */
const StatusCountsInput = z.object({
  gcCustomerId: z.string().optional(),
  q: z.string().trim().max(120).optional(),
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
  /**
   * The Direct Debit picture for ONE customer-CRM contact — powers the
   * "Direct Debit" panel on /contacts/[id]. Read-only and open to all staff
   * (§20.1 contact.read; the same page already shows payments to every
   * role). Resolution: GcCustomers linked to the contact directly, else via
   * any family the contact belongs to.
   */
  contactSummary: protectedProcedure
    .input(z.object({ contactId: z.string() }))
    .query(async ({ ctx, input }) => {
      requireUser(ctx)
      const familyIds = (
        await ctx.db.familyMember.findMany({
          where: { contactId: input.contactId },
          select: { familyId: true },
        })
      ).map((m) => m.familyId)

      const customers = await ctx.db.gcCustomer.findMany({
        where: {
          deletedAt: null,
          OR: [
            { contactId: input.contactId },
            ...(familyIds.length > 0 ? [{ familyId: { in: familyIds } }] : []),
          ],
        },
        orderBy: [{ createdAt: 'asc' }],
        take: 5,
        select: {
          gcCustomerId: true,
          email: true,
          givenName: true,
          familyName: true,
          companyName: true,
        },
      })
      const customerIds = customers.map((c) => c.gcCustomerId)

      const [mandates, subscriptions, payments, setupLinks] = await Promise.all([
        customerIds.length > 0
          ? ctx.db.gcMandate.findMany({
              where: { gcCustomerId: { in: customerIds }, deletedAt: null },
              orderBy: [{ createdAt: 'desc' }],
              take: 10,
              select: {
                gcMandateId: true,
                state: true,
                reference: true,
                scheme: true,
                nextPossibleChargeDate: true,
              },
            })
          : Promise.resolve([]),
        customerIds.length > 0
          ? ctx.db.gcSubscription.findMany({
              where: { gcCustomerId: { in: customerIds }, deletedAt: null },
              orderBy: [{ createdAt: 'desc' }],
              take: 10,
              select: {
                gcSubscriptionId: true,
                name: true,
                status: true,
                amountMinor: true,
                currency: true,
                intervalUnit: true,
                interval: true,
                dayOfMonth: true,
                nextChargeAt: true,
              },
            })
          : Promise.resolve([]),
        customerIds.length > 0
          ? ctx.db.gcPayment.findMany({
              where: { gcCustomerId: { in: customerIds }, deletedAt: null },
              orderBy: [{ chargeDate: 'desc' }, { createdAt: 'desc' }],
              take: 5,
              select: {
                gcPaymentId: true,
                status: true,
                amountMinor: true,
                currency: true,
                description: true,
                chargeDate: true,
              },
            })
          : Promise.resolve([]),
        ctx.db.mandateSetupLink.findMany({
          where: { contactId: input.contactId, deletedAt: null },
          orderBy: [{ createdAt: 'desc' }],
          take: 5,
          select: {
            id: true,
            status: true,
            emailTo: true,
            emailedAt: true,
            openCount: true,
            expiresAt: true,
            completedAt: true,
          },
        }),
      ])

      return {
        customers: customers.map((c) => ({
          gcCustomerId: c.gcCustomerId,
          name:
            [c.givenName, c.familyName].filter(Boolean).join(' ') || c.companyName || null,
          email: c.email,
        })),
        mandates,
        subscriptions,
        payments,
        setupLinks,
      }
    }),

  // Master dashboard for the Direct Debits section (ADR 0038). One query
  // feeds the whole Overview tab: headline KPIs, the needs-attention queues,
  // and the upcoming-collections list.
  overview: protectedProcedure.query(async ({ ctx }) => {
    assertFinanceRole(requireUser(ctx))
    const now = new Date()
    const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

    const [
      subsByStatus,
      customerTotal,
      customerUnlinked,
      mandateActive,
      collected,
      collected30d,
      failed30d,
      inFlight,
      activePlans,
      setupLinksOutstanding,
      upcomingRows,
      failureRows,
    ] = await Promise.all([
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
      ctx.db.gcPayment.aggregate({
        where: {
          deletedAt: null,
          status: { in: ['confirmed', 'paid_out'] },
          chargeDate: { gte: cutoff30d },
        },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      ctx.db.gcPayment.aggregate({
        where: {
          deletedAt: null,
          status: { in: ['failed', 'charged_back'] },
          chargeDate: { gte: cutoff30d },
        },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      // Money in flight: collected from the bank but not yet settled/confirmed.
      ctx.db.gcPayment.aggregate({
        where: {
          deletedAt: null,
          status: { in: ['pending_customer_approval', 'pending_submission', 'submitted'] },
        },
        _sum: { amountMinor: true },
        _count: { _all: true },
      }),
      ctx.db.gcSubscription.findMany({
        where: { deletedAt: null, status: 'active' },
        select: { amountMinor: true, intervalUnit: true, interval: true },
      }),
      ctx.db.mandateSetupLink.count({ where: { deletedAt: null, status: 'active' } }),
      ctx.db.gcSubscription.findMany({
        where: { deletedAt: null, status: 'active', nextChargeAt: { not: null } },
        orderBy: { nextChargeAt: 'asc' },
        take: 8,
        select: {
          gcSubscriptionId: true,
          name: true,
          currency: true,
          amountMinor: true,
          nextChargeAt: true,
          nextChargeMinor: true,
          gcCustomerId: true,
        },
      }),
      ctx.db.gcPayment.findMany({
        where: { deletedAt: null, status: { in: ['failed', 'charged_back'] } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 5,
        select: {
          gcPaymentId: true,
          status: true,
          amountMinor: true,
          currency: true,
          chargeDate: true,
          description: true,
          gcCustomerId: true,
        },
      }),
    ])

    const customers = await loadCustomerSummaries(ctx.db, [
      ...upcomingRows.map((r) => r.gcCustomerId ?? ''),
      ...failureRows.map((r) => r.gcCustomerId ?? ''),
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
      collected30d: {
        totalMinor: collected30d._sum.amountMinor ?? 0,
        count: collected30d._count._all,
      },
      failed30d: {
        totalMinor: failed30d._sum.amountMinor ?? 0,
        count: failed30d._count._all,
      },
      inFlight: {
        totalMinor: inFlight._sum.amountMinor ?? 0,
        count: inFlight._count._all,
      },
      monthlyRunRateMinor: monthlyRunRateMinor(activePlans),
      setupLinks: { outstanding: setupLinksOutstanding },
      upcomingCharges: upcomingRows.map((r) => ({
        gcSubscriptionId: r.gcSubscriptionId,
        name: r.name,
        currency: r.currency,
        amountMinor: r.nextChargeMinor ?? r.amountMinor,
        nextChargeAt: r.nextChargeAt,
        customer: r.gcCustomerId ? (customers.get(r.gcCustomerId) ?? null) : null,
      })),
      recentFailures: failureRows.map((r) => ({
        gcPaymentId: r.gcPaymentId,
        status: r.status,
        amountMinor: r.amountMinor,
        currency: r.currency,
        chargeDate: r.chargeDate,
        description: r.description,
        customer: r.gcCustomerId ? (customers.get(r.gcCustomerId) ?? null) : null,
      })),
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

    /**
     * Full customer record (the GoCardless dashboard's customer page):
     * identity + CRM link, lifetime totals, every mandate, every plan (all
     * statuses), recent payments, and outstanding sign-up links.
     */
    detail: protectedProcedure
      .input(z.object({ gcCustomerId: z.string().min(3).max(120) }))
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const customer = await ctx.db.gcCustomer.findFirst({
          where: { gcCustomerId: input.gcCustomerId, deletedAt: null },
          select: {
            gcCustomerId: true,
            email: true,
            givenName: true,
            familyName: true,
            companyName: true,
            contactId: true,
            familyId: true,
            gcCreatedAt: true,
            createdAt: true,
            contact: { select: { firstName: true, lastName: true, email: true } },
          },
        })
        if (!customer) throw new TRPCError({ code: 'NOT_FOUND', message: 'customer not found' })

        const [mandates, subscriptions, payments, collected, setupLinks] = await Promise.all([
          ctx.db.gcMandate.findMany({
            where: { gcCustomerId: input.gcCustomerId, deletedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              gcMandateId: true,
              state: true,
              reference: true,
              scheme: true,
              nextPossibleChargeDate: true,
              gcCreatedAt: true,
            },
          }),
          ctx.db.gcSubscription.findMany({
            where: { gcCustomerId: input.gcCustomerId, deletedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: {
              gcSubscriptionId: true,
              name: true,
              status: true,
              amountMinor: true,
              currency: true,
              intervalUnit: true,
              interval: true,
              dayOfMonth: true,
              startDate: true,
              endDate: true,
              nextChargeAt: true,
              nextChargeMinor: true,
              gcCreatedAt: true,
            },
          }),
          ctx.db.gcPayment.findMany({
            where: { gcCustomerId: input.gcCustomerId, deletedAt: null },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 15,
            select: {
              gcPaymentId: true,
              status: true,
              amountMinor: true,
              currency: true,
              description: true,
              chargeDate: true,
              gcSubscriptionId: true,
            },
          }),
          ctx.db.gcPayment.aggregate({
            where: {
              gcCustomerId: input.gcCustomerId,
              deletedAt: null,
              status: { in: ['confirmed', 'paid_out'] },
            },
            _sum: { amountMinor: true },
            _count: { _all: true },
          }),
          customer.contactId
            ? ctx.db.mandateSetupLink.findMany({
                where: { contactId: customer.contactId, deletedAt: null },
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                take: 5,
                select: {
                  id: true,
                  status: true,
                  emailTo: true,
                  emailedAt: true,
                  reminderSentAt: true,
                  openCount: true,
                  expiresAt: true,
                  completedAt: true,
                },
              })
            : Promise.resolve([]),
        ])

        return {
          customer: {
            gcCustomerId: customer.gcCustomerId,
            name:
              [customer.givenName, customer.familyName].filter(Boolean).join(' ') ||
              customer.companyName ||
              null,
            email: customer.email,
            contactId: customer.contactId,
            contactName: customer.contact
              ? [customer.contact.firstName, customer.contact.lastName]
                  .filter(Boolean)
                  .join(' ') ||
                customer.contact.email ||
                null
              : null,
            familyId: customer.familyId,
            gcCreatedAt: customer.gcCreatedAt,
            createdAt: customer.createdAt,
          },
          totals: {
            collectedMinor: collected._sum.amountMinor ?? 0,
            paymentCount: collected._count._all,
            activePlans: subscriptions.filter((s) => s.status === 'active').length,
          },
          mandates,
          subscriptions,
          payments,
          setupLinks,
        }
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

  }),

  // Durable Direct Debit sign-up links + automated emails (ADR 0038
  // amendment). We never email a raw GoCardless flow URL (~30 min expiry);
  // we email a CRM token link and mint a fresh flow on each open. The setup
  // email goes out automatically on issue; one automated reminder follows if
  // the mandate is still not in place; links auto-expire after 14 days.
  setupLinks: router({
    send: auditedProcedure
      .input(
        z.object({
          contactId: z.string().min(1),
          description: z.string().trim().min(2).max(255).optional(),
          /** Defaults to the contact's email; override for a different payer address. */
          email: z.string().trim().email().optional(),
          /** Set false to only generate + copy the link (no email). */
          sendEmail: z.boolean().default(true),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)

        const contact = await ctx.db.contact.findFirst({
          where: { id: input.contactId, deletedAt: null },
          select: { id: true, email: true, firstName: true },
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
              'This contact does not belong to a family yet. Billing is family-keyed — add them to a family first, then send the setup link.',
          })
        }

        const emailTo = input.email ?? contact.email ?? null
        if (input.sendEmail && !emailTo) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message:
              'This contact has no email address — add one, provide an override, or generate a copy-only link.',
          })
        }

        const link = await createMandateSetupLink(ctx.db, {
          contactId: input.contactId,
          familyId: member.familyId,
          description: input.description ?? null,
          emailTo,
          actorId: user.id,
        })

        await ctx.audit({
          action: 'gocardless.setup_link.created',
          target: { type: 'Contact', id: input.contactId },
          after: {
            setupLinkId: link.id,
            familyId: member.familyId,
            emailTo,
            sendEmail: input.sendEmail,
            description: input.description ?? null,
          },
        })

        let emailStatus: 'sent' | 'skipped' | 'failed' | 'not_requested' = 'not_requested'
        let emailDetail: string | undefined
        if (input.sendEmail && emailTo) {
          const sent = await sendSetupLinkEmail({
            kind: 'initial',
            link: {
              id: link.id,
              token: link.token,
              description: input.description ?? null,
              expiresAt: link.expiresAt,
              contactId: input.contactId,
              familyId: member.familyId,
            },
            to: emailTo,
            firstName: contact.firstName,
            actorId: user.id,
          })
          emailStatus = sent.status
          emailDetail = sent.detail
        }

        return {
          setupLinkId: link.id,
          url: buildSetupLinkUrl(link.token),
          expiresAt: link.expiresAt,
          emailedTo: emailStatus === 'sent' ? emailTo : null,
          emailStatus,
          emailDetail: emailDetail ?? null,
        }
      }),

    list: protectedProcedure
      .input(
        z.object({
          view: z.enum(['outstanding', 'all']).default('outstanding'),
          limit: z.number().min(1).max(100).default(50),
        }),
      )
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const rows = await ctx.db.mandateSetupLink.findMany({
          where: {
            deletedAt: null,
            ...(input.view === 'outstanding' ? { status: 'active' } : {}),
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: input.limit,
          select: {
            id: true,
            token: true,
            status: true,
            description: true,
            expiresAt: true,
            emailTo: true,
            emailedAt: true,
            reminderSentAt: true,
            lastOpenedAt: true,
            openCount: true,
            completedAt: true,
            gcMandateId: true,
            createdAt: true,
            contact: { select: { id: true, firstName: true, lastName: true, email: true } },
          },
        })
        return {
          items: rows.map((r) => ({
            id: r.id,
            url: buildSetupLinkUrl(r.token),
            status: r.status,
            description: r.description,
            expiresAt: r.expiresAt,
            emailTo: r.emailTo,
            emailedAt: r.emailedAt,
            reminderSentAt: r.reminderSentAt,
            lastOpenedAt: r.lastOpenedAt,
            openCount: r.openCount,
            completedAt: r.completedAt,
            gcMandateId: r.gcMandateId,
            createdAt: r.createdAt,
            contactId: r.contact.id,
            contactName:
              [r.contact.firstName, r.contact.lastName].filter(Boolean).join(' ') ||
              r.contact.email ||
              'Contact',
          })),
        }
      }),

    resend: auditedProcedure
      .input(z.object({ id: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const link = await ctx.db.mandateSetupLink.findFirst({
          where: { id: input.id, deletedAt: null },
          select: {
            id: true,
            token: true,
            status: true,
            description: true,
            expiresAt: true,
            emailTo: true,
            contactId: true,
            familyId: true,
            contact: { select: { firstName: true, email: true } },
          },
        })
        if (!link) throw new TRPCError({ code: 'NOT_FOUND' })
        if (link.status !== 'active') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: `This link is ${link.status} — send a new one instead.`,
          })
        }
        const to = link.emailTo ?? link.contact.email
        if (!to) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'No email address on this link or contact.',
          })
        }
        const sent = await sendSetupLinkEmail({
          kind: 'initial',
          link: {
            id: link.id,
            token: link.token,
            description: link.description,
            expiresAt: link.expiresAt,
            contactId: link.contactId,
            familyId: link.familyId,
          },
          to,
          firstName: link.contact.firstName,
          actorId: user.id,
        })
        if (sent.status !== 'sent') {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: sent.detail ?? 'Email could not be sent',
          })
        }
        await ctx.audit({
          action: 'gocardless.setup_link.emailed',
          target: { type: 'Contact', id: link.contactId },
          after: { setupLinkId: link.id, to, kind: 'resend' },
        })
        return { ok: true, emailedTo: to }
      }),

    revoke: auditedProcedure
      .input(z.object({ id: z.string().min(1), reason: z.string().trim().min(2).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const link = await ctx.db.mandateSetupLink.findFirst({
          where: { id: input.id, deletedAt: null },
          select: { contactId: true },
        })
        if (!link) throw new TRPCError({ code: 'NOT_FOUND' })
        const result = await revokeSetupLink(ctx.db, {
          setupLinkId: input.id,
          actorId: user.id,
        })
        if (!result.ok) {
          throw new TRPCError({
            code: result.reason === 'not_found' ? 'NOT_FOUND' : 'CONFLICT',
            message: result.reason,
          })
        }
        await ctx.audit({
          action: 'gocardless.setup_link.revoked',
          target: { type: 'Contact', id: link.contactId },
          after: { setupLinkId: input.id, reason: input.reason },
        })
        return { ok: true }
      }),
  }),

  subscriptions: router({
    list: protectedProcedure.input(SubscriptionListInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      // An exact customer filter wins over free-text search.
      const searchIds = input.gcCustomerId
        ? null
        : await resolveCustomerIdsForQuery(ctx.db, input.q)
      if (searchIds !== null && searchIds.length === 0) {
        return { items: [], nextCursor: null }
      }
      const rows = await ctx.db.gcSubscription.findMany({
        where: {
          deletedAt: null,
          ...(input.status !== 'all' ? { status: input.status as GcSubscriptionState } : {}),
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(searchIds !== null ? { gcCustomerId: { in: searchIds } } : {}),
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

    /** Per-status counts for the list's filter strip (GoCardless-style tabs). */
    statusCounts: protectedProcedure.input(StatusCountsInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const searchIds = input.gcCustomerId
        ? null
        : await resolveCustomerIdsForQuery(ctx.db, input.q)
      if (searchIds !== null && searchIds.length === 0) {
        return { counts: {}, total: 0 }
      }
      const rows = await ctx.db.gcSubscription.groupBy({
        by: ['status'],
        where: {
          deletedAt: null,
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(searchIds !== null ? { gcCustomerId: { in: searchIds } } : {}),
        },
        _count: { _all: true },
      })
      const counts: Record<string, number> = {}
      let total = 0
      for (const row of rows) {
        counts[row.status] = row._count._all
        total += row._count._all
      }
      return { counts, total }
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
      const searchIds = input.gcCustomerId
        ? null
        : await resolveCustomerIdsForQuery(ctx.db, input.q)
      if (searchIds !== null && searchIds.length === 0) {
        return { items: [], nextCursor: null }
      }
      const rows = await ctx.db.gcPayment.findMany({
        where: {
          deletedAt: null,
          ...(input.status !== 'all' ? { status: input.status as GcPaymentState } : {}),
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(searchIds !== null ? { gcCustomerId: { in: searchIds } } : {}),
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

    /** Per-status counts for the list's filter strip (GoCardless-style tabs). */
    statusCounts: protectedProcedure.input(StatusCountsInput).query(async ({ ctx, input }) => {
      assertFinanceRole(requireUser(ctx))
      const searchIds = input.gcCustomerId
        ? null
        : await resolveCustomerIdsForQuery(ctx.db, input.q)
      if (searchIds !== null && searchIds.length === 0) {
        return { counts: {}, total: 0 }
      }
      const rows = await ctx.db.gcPayment.groupBy({
        by: ['status'],
        where: {
          deletedAt: null,
          ...(input.gcCustomerId ? { gcCustomerId: input.gcCustomerId } : {}),
          ...(searchIds !== null ? { gcCustomerId: { in: searchIds } } : {}),
        },
        _count: { _all: true },
      })
      const counts: Record<string, number> = {}
      let total = 0
      for (const row of rows) {
        counts[row.status] = row._count._all
        total += row._count._all
      }
      return { counts, total }
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
