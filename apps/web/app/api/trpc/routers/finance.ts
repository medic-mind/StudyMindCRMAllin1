// Finance router. See CLAUDE.md §27 (tRPC conventions), §20 (RBAC),
// §6.3 (reconciliation triangle), §3 (never auto-resolve).

import { createId } from '@paralleldrive/cuid2'
import { TRPCError } from '@trpc/server'
import type { PrismaClient } from '@prisma/client'
import { z } from 'zod'

import {
  assignCase,
  CaseTransitionError,
  DD_CASE_STATUSES,
  defaulterDetail,
  dismissUnresolvedStripePayment,
  getCasesForSubscriptions,
  getOrCreateCase,
  listActivePlanArrears,
  listDefaulters,
  listPlanShortfalls,
  listUnresolvedStripePayments,
  recordRecovery,
  RECOVERY_METHODS,
  setCaseNotes,
  setCaseStatus,
  paymentsForFamily,
  paymentSummaryForFamily,
  resolveUnresolvedStripePayment,
} from '@studymind/core/finance'

import { sendSystemEmail } from '@studymind/integration-gmail/system-send'
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
      'la_family_with_card_subscription',
      'direct_debit_default',
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

// Per-customer payments panel (Slice A). Accepts either a familyId or a
// contactId — a Contact's payments are its Family's payments (CLAUDE.md §6.1).
const CustomerPaymentsInput = z
  .object({
    familyId: z.string().min(1).optional(),
    contactId: z.string().min(1).optional(),
  })
  .refine((v) => !!v.familyId || !!v.contactId, {
    message: 'familyId or contactId is required',
  })

/**
 * Resolve the Family for the given input. When a contactId is supplied we
 * follow the (single) FamilyMember link. Returns null when the contact has no
 * family (the caller renders an empty "link to a family" state).
 */
async function resolveFamilyId(
  db: PrismaClient,
  input: { familyId?: string; contactId?: string },
): Promise<string | null> {
  if (input.familyId) {
    const family = await db.family.findFirst({
      where: { id: input.familyId, deletedAt: null },
      select: { id: true },
    })
    return family?.id ?? null
  }
  const member = await db.familyMember.findFirst({
    where: { contactId: input.contactId, family: { deletedAt: null } },
    select: { familyId: true },
    orderBy: { createdAt: 'asc' },
  })
  return member?.familyId ?? null
}

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

  // Per-customer payments panel (Slice A). Financial data — every read is
  // audited (CLAUDE.md §20). These are queries, so the auditedProcedure
  // middleware does not enforce; we call ctx.audit explicitly.
  customerPayments: router({
    list: protectedProcedure
      .input(CustomerPaymentsInput)
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const familyId = await resolveFamilyId(ctx.db, input)
        if (!familyId) {
          // Contact without a family — no billing relationship yet.
          return { familyId: null, items: [] }
        }
        const items = await paymentsForFamily(ctx.db, familyId)
        await ctx.audit({
          action: 'finance.payments_viewed',
          target: { type: 'Family', id: familyId },
          purpose: 'view_customer_payments',
          after: { view: 'list', count: items.length },
        })
        return { familyId, items }
      }),

    summary: protectedProcedure
      .input(CustomerPaymentsInput)
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const familyId = await resolveFamilyId(ctx.db, input)
        if (!familyId) {
          return { familyId: null, summary: null }
        }
        const summary = await paymentSummaryForFamily(ctx.db, familyId)
        await ctx.audit({
          action: 'finance.payments_viewed',
          target: { type: 'Family', id: familyId },
          purpose: 'view_customer_payments',
          after: { view: 'summary' },
        })
        return { familyId, summary }
      }),
  }),

  // Direct Debit defaulters view (Slice B). Read-only analysis over the
  // existing mandate / payment / invoice mirrors — never auto-charges or
  // auto-duns (CLAUDE.md §3). Financial data: every read is audited.
  directDebit: router({
    listDefaulters: protectedProcedure
      .input(z.object({}).optional())
      .query(async ({ ctx }) => {
        assertFinanceRole(requireUser(ctx))
        const items = await listDefaulters(ctx.db)
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-defaulters' },
          purpose: 'view_dd_defaulters',
          after: { count: items.length },
        })
        return { items }
      }),

    detail: protectedProcedure
      .input(z.object({ familyId: z.string().min(1) }))
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const detail = await defaulterDetail(ctx.db, input.familyId)
        if (!detail) throw new TRPCError({ code: 'NOT_FOUND', message: 'family not found' })
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'Family', id: input.familyId },
          purpose: 'view_dd_defaulter_detail',
          after: { view: 'detail' },
        })
        return detail
      }),

    // Plans cancelled / finished part-way that left contracted instalments
    // uncollected (ADR 0038). Complements listDefaulters: this catches families
    // who quietly stopped a fixed-length plan early without ever failing a
    // Direct Debit. Read-only; audited like every finance read.
    listPlanShortfalls: protectedProcedure
      .input(z.object({}).optional())
      .query(async ({ ctx }) => {
        assertFinanceRole(requireUser(ctx))
        const items = await listPlanShortfalls(ctx.db)
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-plan-shortfalls' },
          purpose: 'view_dd_plan_shortfalls',
          after: { count: items.length },
        })
        return { items }
      }),

    // Active plans that have fallen behind their expected collection schedule
    // (ADR 0038) — money leaking before anyone cancels the plan. Estimate only
    // (GoCardless owns the real calendar); read-only and audited.
    listActivePlanArrears: protectedProcedure
      .input(z.object({}).optional())
      .query(async ({ ctx }) => {
        assertFinanceRole(requireUser(ctx))
        const items = await listActivePlanArrears(ctx.db)
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-active-arrears' },
          purpose: 'view_dd_active_arrears',
          after: { count: items.length },
        })
        return { items }
      }),

    // Direct Debit recovery cases (ADR 0038, seventh amendment): the agent
    // workflow over a shortfall — status, owner, notes. Reads + writes are
    // finance-role (Manager+), matching the rest of the Direct Debit section.
    // Read-only on money; outbound recovery comms are human-confirmed elsewhere.
    cases: router({
      assignableUsers: protectedProcedure.query(async ({ ctx }) => {
        assertFinanceRole(requireUser(ctx))
        const users = await ctx.db.user.findMany({
          where: { isActive: true, deactivatedAt: null },
          select: { id: true, name: true, email: true },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        })
        return users.map((u) => ({ id: u.id, name: u.name ?? u.email }))
      }),

      forSubscriptions: protectedProcedure
        .input(z.object({ gcSubscriptionIds: z.array(z.string()).max(500) }))
        .query(async ({ ctx, input }) => {
          assertFinanceRole(requireUser(ctx))
          const cases = await getCasesForSubscriptions(ctx.db, input.gcSubscriptionIds)
          const ownerIds = Array.from(
            new Set(
              [...cases.values()]
                .map((c) => c.ownerUserId)
                .filter((id): id is string => id !== null),
            ),
          )
          const owners =
            ownerIds.length > 0
              ? await ctx.db.user.findMany({
                  where: { id: { in: ownerIds } },
                  select: { id: true, name: true, email: true },
                })
              : []
          const ownerName = new Map(owners.map((o) => [o.id, o.name ?? o.email]))
          return {
            cases: [...cases.values()].map((c) => ({
              gcSubscriptionId: c.gcSubscriptionId,
              status: c.status,
              ownerUserId: c.ownerUserId,
              ownerName: c.ownerUserId ? (ownerName.get(c.ownerUserId) ?? null) : null,
              notes: c.notes,
              recoveredMinor: c.recoveredMinor,
              recoveredAt: c.recoveredAt,
              recoveryMethod: c.recoveryMethod,
              recoveryRef: c.recoveryRef,
            })),
          }
        }),

      setStatus: protectedProcedure
        .input(
          z.object({
            gcSubscriptionId: z.string().min(1),
            status: z.enum(DD_CASE_STATUSES as [string, ...string[]]),
            links: z
              .object({
                gcCustomerId: z.string().nullish(),
                contactId: z.string().nullish(),
                familyId: z.string().nullish(),
                openingShortfallMinor: z.number().int().nonnegative().optional(),
              })
              .optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          try {
            const result = await setCaseStatus(ctx.db, {
              gcSubscriptionId: input.gcSubscriptionId,
              to: input.status as (typeof DD_CASE_STATUSES)[number],
              actorId: user.id,
              links: input.links,
            })
            await ctx.audit({
              action: 'direct_debit.case_status_changed',
              target: { type: 'DirectDebitCase', id: input.gcSubscriptionId },
              before: { status: result.from },
              after: { status: input.status },
            })
            return { status: result.case.status }
          } catch (e) {
            if (e instanceof CaseTransitionError) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: e.message })
            }
            throw e
          }
        }),

      assign: protectedProcedure
        .input(
          z.object({
            gcSubscriptionId: z.string().min(1),
            ownerUserId: z.string().nullable(),
            links: z
              .object({
                gcCustomerId: z.string().nullish(),
                contactId: z.string().nullish(),
                familyId: z.string().nullish(),
                openingShortfallMinor: z.number().int().nonnegative().optional(),
              })
              .optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const updated = await assignCase(ctx.db, {
            gcSubscriptionId: input.gcSubscriptionId,
            ownerUserId: input.ownerUserId,
            actorId: user.id,
            links: input.links,
          })
          await ctx.audit({
            action: 'direct_debit.case_assigned',
            target: { type: 'DirectDebitCase', id: input.gcSubscriptionId },
            after: { ownerUserId: updated.ownerUserId },
          })
          return { ownerUserId: updated.ownerUserId }
        }),

      setNotes: protectedProcedure
        .input(
          z.object({
            gcSubscriptionId: z.string().min(1),
            notes: z.string().max(5000).nullable(),
            links: z
              .object({
                gcCustomerId: z.string().nullish(),
                contactId: z.string().nullish(),
                familyId: z.string().nullish(),
                openingShortfallMinor: z.number().int().nonnegative().optional(),
              })
              .optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          await setCaseNotes(ctx.db, {
            gcSubscriptionId: input.gcSubscriptionId,
            notes: input.notes,
            actorId: user.id,
            links: input.links,
          })
          await ctx.audit({
            action: 'direct_debit.case_note_updated',
            target: { type: 'DirectDebitCase', id: input.gcSubscriptionId },
            after: { hasNotes: Boolean(input.notes) },
          })
          return { ok: true }
        }),

      // Record how a shortfall was recovered (bank transfer via the invoicing
      // site, Stripe, re-collected DD, or manual) — an agent confirming money
      // arrived elsewhere. Closes the case as recovered. Records only; never
      // charges (CLAUDE.md §3). Audited as a money-adjacent write.
      recordRecovery: protectedProcedure
        .input(
          z.object({
            gcSubscriptionId: z.string().min(1),
            recoveredMinor: z.number().int().nonnegative(),
            method: z.enum(RECOVERY_METHODS as [string, ...string[]]),
            ref: z.string().max(200).nullish(),
            links: z
              .object({
                gcCustomerId: z.string().nullish(),
                contactId: z.string().nullish(),
                familyId: z.string().nullish(),
                openingShortfallMinor: z.number().int().nonnegative().optional(),
              })
              .optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const updated = await recordRecovery(ctx.db, {
            gcSubscriptionId: input.gcSubscriptionId,
            recoveredMinor: input.recoveredMinor,
            method: input.method as (typeof RECOVERY_METHODS)[number],
            ref: input.ref ?? null,
            actorId: user.id,
            links: input.links,
          })
          await ctx.audit({
            action: 'direct_debit.case_recovered',
            target: { type: 'DirectDebitCase', id: input.gcSubscriptionId },
            after: {
              recoveredMinor: updated.recoveredMinor,
              method: updated.recoveryMethod,
              ref: updated.recoveryRef,
            },
          })
          return { status: updated.status, recoveredMinor: updated.recoveredMinor }
        }),

      // Send a human-confirmed recovery email (reminder / legal escalation) from
      // a case (Phase 3b). The agent has already reviewed/edited the final
      // subject + body in the dialog — this just sends it via the system mailbox,
      // logs it on the customer's timeline (so it reflects on the customer page),
      // and nudges a `new` case to `chasing`. Email only for now. CLAUDE.md §3,
      // §14 (system Gmail, never a third-party email API).
      sendRecovery: protectedProcedure
        .input(
          z.object({
            gcSubscriptionId: z.string().min(1),
            contactId: z.string().min(1),
            templateId: z.string().nullish(),
            subject: z.string().trim().min(1).max(300),
            body: z.string().trim().min(1).max(10_000),
            links: z
              .object({
                gcCustomerId: z.string().nullish(),
                familyId: z.string().nullish(),
                openingShortfallMinor: z.number().int().nonnegative().optional(),
              })
              .optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)

          const contact = await ctx.db.contact.findFirst({
            where: { id: input.contactId, deletedAt: null },
            select: { id: true, email: true },
          })
          if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'contact not found' })
          if (!contact.email) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'This contact has no email address — add one before sending.',
            })
          }

          const result = await sendSystemEmail({
            to: contact.email,
            subject: input.subject,
            text: input.body,
          })
          if (result.status !== 'sent') {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message:
                result.detail ??
                (result.status === 'skipped'
                  ? 'No system mailbox connected — connect Gmail in Settings.'
                  : 'The email could not be sent.'),
            })
          }

          // Reflect on the customer's CRM page.
          await ctx.db.interaction.create({
            data: {
              id: createId(),
              type: 'email_sent',
              contactId: contact.id,
              occurredAt: new Date(),
              summary: `Direct Debit recovery email: ${input.subject}`.slice(0, 140),
              payload: {
                kind: 'dd_recovery',
                subject: input.subject,
                body: input.body,
                to: contact.email,
                gcSubscriptionId: input.gcSubscriptionId,
                templateId: input.templateId ?? null,
                gmailId: result.id,
                authorId: user.id,
              },
              createdById: user.id,
              updatedById: user.id,
            },
          })

          // Nudge a brand-new case into `chasing` once the first message goes out.
          const current = await getOrCreateCase(ctx.db, {
            gcSubscriptionId: input.gcSubscriptionId,
            actorId: user.id,
            contactId: input.contactId,
            gcCustomerId: input.links?.gcCustomerId,
            familyId: input.links?.familyId,
            openingShortfallMinor: input.links?.openingShortfallMinor,
          })
          if (current.status === 'new') {
            await setCaseStatus(ctx.db, {
              gcSubscriptionId: input.gcSubscriptionId,
              to: 'chasing',
              actorId: user.id,
            })
          }

          await ctx.audit({
            action: 'direct_debit.recovery_sent',
            target: { type: 'DirectDebitCase', id: input.gcSubscriptionId },
            after: { channel: 'email', to: contact.email, subject: input.subject },
          })
          return { status: 'sent' as const }
        }),
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

  // Successful Stripe charges with no StripeCustomer→Family mapping (ADR 0030).
  // A human links each to a Family (records the Payment + creates the mapping)
  // or dismisses it. We never auto-create a Family from a payment (CLAUDE.md §3).
  unresolvedPayments: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      assertFinanceRole(requireUser(ctx))
      const items = await listUnresolvedStripePayments(ctx.db)
      return { items }
    }),

    resolve: auditedProcedure
      .input(z.object({ id: z.string().min(1), familyId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const result = await resolveUnresolvedStripePayment(ctx.db, {
          id: input.id,
          familyId: input.familyId,
          actorId: user.id,
        })
        if (!result.ok) {
          throw new TRPCError({
            code:
              result.reason === 'not_found' || result.reason === 'family_not_found'
                ? 'NOT_FOUND'
                : 'CONFLICT',
            message: result.reason,
          })
        }
        await ctx.audit({
          action: 'finance.unresolved_payment_resolved',
          target: { type: 'Family', id: result.familyId },
          after: {
            unresolvedPaymentId: input.id,
            paymentId: result.paymentId,
            familyId: result.familyId,
          },
        })
        return { paymentId: result.paymentId }
      }),

    dismiss: auditedProcedure
      .input(z.object({ id: z.string().min(1), reason: z.string().min(3).max(500) }))
      .mutation(async ({ ctx, input }) => {
        const user = requireUser(ctx)
        assertFinanceRole(user)
        const result = await dismissUnresolvedStripePayment(ctx.db, {
          id: input.id,
          reason: input.reason,
          actorId: user.id,
        })
        if (!result.ok) {
          throw new TRPCError({
            code: result.reason === 'not_found' ? 'NOT_FOUND' : 'CONFLICT',
            message: result.reason,
          })
        }
        await ctx.audit({
          action: 'finance.unresolved_payment_dismissed',
          target: { type: 'UnresolvedStripePayment', id: input.id },
          after: { reason: input.reason },
        })
        return { id: result.id }
      }),
  }),
})
