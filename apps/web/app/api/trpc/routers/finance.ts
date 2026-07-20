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
  ddIssueMeetsCutoff,
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
  renderRecoveryLetterPdf,
  resolveDdIssueCutoff,
  setCaseNotes,
  setCaseStatus,
  paymentsForFamily,
  paymentSummaryForFamily,
  resolveUnresolvedStripePayment,
} from '@studymind/core/finance'
import { roleCan } from '@studymind/core/auth/policies'

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
import { buildCaseRecoveryVars } from '@/lib/finance/recovery-vars'
import { companyLetterhead, loadDdRecoverySettings } from '@/lib/finance/recovery-settings'

// Refunds + allocation review + reconciliation are restricted to roles that
// can move money. ADR 0014 — ceo, senior_manager, manager. Sales Executive
// can create payment links (below) but never issues refunds.
const FINANCE_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
])

// charge.create_link is allowed for every sales role — Sales Executive AND
// Virtual Assistant (operator decision 2026-07, CLAUDE.md §20.1).
const PAYMENT_LINK_ROLES: ReadonlySet<SessionUser['role']> = new Set([
  'ceo',
  'senior_manager',
  'manager',
  'sales_executive',
  'virtual_assistant',
])

function assertFinanceRole(user: SessionUser): void {
  if (!FINANCE_ROLES.has(user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'finance role required' })
  }
}

// Issuing a refund is gated on the `charge.refund` action (CLAUDE.md §20.1):
// CEO, Senior Manager, Manager, and — operator decision 2026-07 — Sales
// Executive + Virtual Assistant. This is deliberately narrower than the blanket
// FINANCE_ROLES gate above: broader finance operations (reconciliation,
// discrepancy resolution, unresolved-payment linking, payouts) stay Manager+.
function assertCanRefund(user: SessionUser): void {
  if (!roleCan(user.role, 'charge.refund')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'refund permission required' })
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
      .input(z.object({ includeHistoric: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const all = await listDefaulters(ctx.db)
        // Hide pre-go-live historic issues unless explicitly shown (ADR 0045).
        const cutoff = resolveDdIssueCutoff(process.env.DD_ISSUES_CUTOFF_DATE)
        const items = input?.includeHistoric
          ? all
          : all.filter((d) => ddIssueMeetsCutoff(d.issueDate, cutoff))
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-defaulters' },
          purpose: 'view_dd_defaulters',
          after: { count: items.length },
        })
        return { items, hiddenHistoric: all.length - items.length }
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
      .input(z.object({ includeHistoric: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const all = await listPlanShortfalls(ctx.db)
        const cutoff = resolveDdIssueCutoff(process.env.DD_ISSUES_CUTOFF_DATE)
        const items = input?.includeHistoric
          ? all
          : all.filter((s) => ddIssueMeetsCutoff(s.issueDate, cutoff))
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-plan-shortfalls' },
          purpose: 'view_dd_plan_shortfalls',
          after: { count: items.length },
        })
        return { items, hiddenHistoric: all.length - items.length }
      }),

    // Active plans that have fallen behind their expected collection schedule
    // (ADR 0038) — money leaking before anyone cancels the plan. Estimate only
    // (GoCardless owns the real calendar); read-only and audited.
    listActivePlanArrears: protectedProcedure
      .input(z.object({ includeHistoric: z.boolean().default(false) }).optional())
      .query(async ({ ctx, input }) => {
        assertFinanceRole(requireUser(ctx))
        const all = await listActivePlanArrears(ctx.db)
        const cutoff = resolveDdIssueCutoff(process.env.DD_ISSUES_CUTOFF_DATE)
        const items = input?.includeHistoric
          ? all
          : all.filter((a) => ddIssueMeetsCutoff(a.issueDate, cutoff))
        await ctx.audit({
          action: 'finance.dd_defaulters_viewed',
          target: { type: 'System', id: 'direct-debit-active-arrears' },
          purpose: 'view_dd_active_arrears',
          after: { count: items.length },
        })
        return { items, hiddenHistoric: all.length - items.length }
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

      // ---- Automated chasing (ADR 0045) -----------------------------------

      /** The chase workspace: cases with their automation state. Reads open to
       *  all staff; the money-adjacent writes below stay Manager+. */
      chaseList: protectedProcedure
        .input(
          z
            .object({ view: z.enum(['open', 'needs_link', 'resolved', 'all']).default('open') })
            .default({ view: 'open' }),
        )
        .query(async ({ ctx, input }) => {
          requireUser(ctx)
          const OPEN = ['new', 'chasing', 'escalated'] as const
          const where =
            input.view === 'open'
              ? { status: { in: [...OPEN] } }
              : input.view === 'needs_link'
                ? { status: { in: [...OPEN] }, setupLinkUrl: null }
                : input.view === 'resolved'
                  ? { status: { in: ['recovered', 'written_off'] as ('recovered' | 'written_off')[] } }
                  : {}
          const rows = await ctx.db.directDebitCase.findMany({
            where: { deletedAt: null, ...where },
            orderBy: [{ createdAt: 'desc' }],
            take: 200,
            include: { _count: { select: { messages: true } } },
          })
          const contactIds = [
            ...new Set(rows.map((r) => r.contactId).filter((id): id is string => id !== null)),
          ]
          const contacts =
            contactIds.length > 0
              ? await ctx.db.contact.findMany({
                  where: { id: { in: contactIds } },
                  select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
                })
              : []
          const contactById = new Map(contacts.map((c) => [c.id, c]))
          return rows.map((r) => {
            const c = r.contactId ? contactById.get(r.contactId) : null
            const contactName = c
              ? [c.firstName, c.lastName].filter(Boolean).join(' ') || null
              : null
            // Display name: linked contact wins, then the standalone case's own
            // name (ADR 0045 amendment), then whichever identifier we have.
            const name =
              contactName || r.personName || r.chaseEmail || r.chasePhoneE164 || 'Unknown'
            return {
              id: r.id,
              status: r.status,
              contactId: r.contactId,
              contactName,
              personName: r.personName,
              name,
              gcSubscriptionId: r.gcSubscriptionId,
              outstandingMinor: Math.max(0, r.openingShortfallMinor - r.recoveredMinor),
              autoChase: r.autoChase,
              sendEmails: r.sendEmails,
              sendTexts: r.sendTexts,
              chaseEmail: r.chaseEmail,
              chasePhoneE164: r.chasePhoneE164,
              setupLinkUrl: r.setupLinkUrl,
              cadenceDays: r.cadenceDays,
              escalationStep: r.escalationStep,
              lastAutoMessageAt: r.lastAutoMessageAt,
              nextAutoMessageAt: r.nextAutoMessageAt,
              messageCount: r._count.messages,
              createdAt: r.createdAt,
              recoveredAt: r.recoveredAt,
              recoveryMethod: r.recoveryMethod,
            }
          })
        }),

      /** Manually add a customer to the chase system — e.g. a cancelled DD
       *  with an outstanding amount that the scan can't see (ADR 0045). */
      openManualChase: protectedProcedure
        .input(
          z.object({
            // A case can be a STANDALONE person (ADR 0045 amendment) — most
            // defaulters predate the CRM — so contactId is optional; give a
            // personName instead. One of contactId / personName is required.
            contactId: z.string().min(1).nullish(),
            personName: z.string().trim().max(200).nullish(),
            outstandingMinor: z.number().int().nonnegative().default(0),
            setupLinkUrl: z.string().trim().url().max(600).nullish(),
            sendEmails: z.boolean().default(true),
            sendTexts: z.boolean().default(false),
            chaseEmail: z.string().trim().email().max(200).nullish(),
            chasePhoneE164: z.string().trim().max(20).nullish(),
            // Omit to use the configurable default cadence (Settings → DD recovery).
            cadenceDays: z.number().int().min(1).max(30).optional(),
            notes: z.string().max(5000).nullish(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const cadenceDays =
            input.cadenceDays ?? (await loadDdRecoverySettings(ctx.db)).defaultCadenceDays

          let contactId: string | null = null
          let chaseEmail = input.chaseEmail ?? null
          let chasePhoneE164 = input.chasePhoneE164 ?? null
          let gcCustomerId: string | null = null
          let personName = input.personName?.trim() || null

          if (input.contactId) {
            const contact = await ctx.db.contact.findFirst({
              where: { id: input.contactId, deletedAt: null },
              select: { id: true, email: true, phoneE164: true },
            })
            if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'contact not found' })
            contactId = contact.id
            chaseEmail = chaseEmail ?? contact.email
            chasePhoneE164 = chasePhoneE164 ?? contact.phoneE164
            // Link the GC customer when the contact is already in the mirror, so
            // the engine's auto-resolve (fresh active mandate) works.
            const gcCustomer = await ctx.db.gcCustomer.findFirst({
              where: { contactId: contact.id },
              select: { gcCustomerId: true },
            })
            gcCustomerId = gcCustomer?.gcCustomerId ?? null
            personName = null // the linked contact's name wins
          } else if (!personName) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Add a name or pick a contact.',
            })
          }

          // Must be able to reach them on any channel they've enabled.
          if (input.sendEmails && !chaseEmail) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Add an email address, or turn off email chasing.',
            })
          }
          if (input.sendTexts && !(chasePhoneE164 && chasePhoneE164.trim().startsWith('+'))) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'Add an E.164 phone (+…), or turn off text chasing.',
            })
          }

          const id = createId()
          await ctx.db.directDebitCase.create({
            data: {
              id,
              gcSubscriptionId: null,
              gcCustomerId,
              contactId,
              personName,
              status: 'new',
              openingShortfallMinor: input.outstandingMinor,
              sendEmails: input.sendEmails,
              sendTexts: input.sendTexts,
              chaseEmail,
              chasePhoneE164,
              setupLinkUrl: input.setupLinkUrl ?? null,
              cadenceDays,
              // Armed the moment a link exists; otherwise waits in "needs link".
              nextAutoMessageAt: input.setupLinkUrl ? new Date() : null,
              ownerUserId: user.id,
              notes: input.notes ?? null,
              createdById: user.id,
              updatedById: user.id,
            },
          })
          await ctx.audit({
            action: 'direct_debit.case_opened',
            target: { type: 'DirectDebitCase', id },
            after: {
              manual: true,
              contactId,
              personName,
              outstandingMinor: input.outstandingMinor,
            },
          })
          return { id }
        }),

      /**
       * Open the full recovery case for a detected defaulter FAMILY — find an
       * existing open case for the family's billing contact, else create one
       * seeded from the defaulter figures. Lets the Issues-tab defaulter list
       * expand into the same rich case view (comms history, pause/resume, send)
       * as the recovery worklist, instead of being a dead-end drill-down.
       * Returns the case id for the client to open in the modal.
       */
      openCaseForFamily: protectedProcedure
        .input(
          z.object({
            familyId: z.string().min(1),
            outstandingMinor: z.number().int().nonnegative().default(0),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)

          const family = await ctx.db.family.findFirst({
            where: { id: input.familyId, deletedAt: null },
            select: { id: true, billingContactId: true },
          })
          if (!family?.billingContactId) {
            throw new TRPCError({
              code: 'BAD_REQUEST',
              message: 'This family has no billing contact to open a case for.',
            })
          }
          const contactId = family.billingContactId

          // Reuse an existing in-flight case for this contact — never spawn a
          // duplicate case each time the row is opened.
          const existing = await ctx.db.directDebitCase.findFirst({
            where: { contactId, status: { notIn: ['recovered', 'written_off'] } },
            orderBy: { createdAt: 'desc' },
            select: { id: true },
          })
          if (existing) return { id: existing.id, created: false }

          const contact = await ctx.db.contact.findFirst({
            where: { id: contactId, deletedAt: null },
            select: { email: true, phoneE164: true },
          })
          const gcCustomer = await ctx.db.gcCustomer.findFirst({
            where: { contactId },
            select: { gcCustomerId: true },
          })
          const cadenceDays = (await loadDdRecoverySettings(ctx.db)).defaultCadenceDays

          const id = createId()
          await ctx.db.directDebitCase.create({
            data: {
              id,
              gcSubscriptionId: null,
              gcCustomerId: gcCustomer?.gcCustomerId ?? null,
              contactId,
              personName: null,
              status: 'new',
              openingShortfallMinor: input.outstandingMinor,
              // Start with auto-send OFF: the case is created just to review /
              // work it; the human arms channels + link in the modal (§3).
              sendEmails: false,
              sendTexts: false,
              chaseEmail: contact?.email ?? null,
              chasePhoneE164: contact?.phoneE164 ?? null,
              setupLinkUrl: null,
              cadenceDays,
              nextAutoMessageAt: null,
              ownerUserId: user.id,
              createdById: user.id,
              updatedById: user.id,
            },
          })
          await ctx.audit({
            action: 'direct_debit.case_opened',
            target: { type: 'DirectDebitCase', id },
            after: { fromDefaulter: true, familyId: input.familyId, contactId, outstandingMinor: input.outstandingMinor },
          })
          return { id, created: true }
        }),

      /** Edit a case's chase settings: contact details, channel flags, the
       *  re-signup link, cadence, or the master auto-chase switch. */
      updateChase: protectedProcedure
        .input(
          z.object({
            caseId: z.string().min(1),
            autoChase: z.boolean().optional(),
            sendEmails: z.boolean().optional(),
            sendTexts: z.boolean().optional(),
            chaseEmail: z.string().trim().email().max(200).nullish(),
            chasePhoneE164: z.string().trim().max(20).nullish(),
            setupLinkUrl: z.string().trim().url().max(600).nullish(),
            cadenceDays: z.number().int().min(1).max(30).optional(),
            outstandingMinor: z.number().int().nonnegative().optional(),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const existing = await ctx.db.directDebitCase.findFirst({
            where: { id: input.caseId, deletedAt: null },
          })
          if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
          const patch: Record<string, unknown> = { updatedById: user.id }
          for (const k of [
            'autoChase',
            'sendEmails',
            'sendTexts',
            'cadenceDays',
          ] as const) {
            if (input[k] !== undefined) patch[k] = input[k]
          }
          for (const k of ['chaseEmail', 'chasePhoneE164', 'setupLinkUrl'] as const) {
            if (input[k] !== undefined) patch[k] = input[k]
          }
          if (input.outstandingMinor !== undefined) {
            patch['openingShortfallMinor'] = input.outstandingMinor
          }
          // Arm the engine when a link appears (or auto-chase is switched back
          // on with a link present) and nothing is scheduled yet.
          const linkAfter = input.setupLinkUrl !== undefined ? input.setupLinkUrl : existing.setupLinkUrl
          const autoAfter = input.autoChase !== undefined ? input.autoChase : existing.autoChase
          if (linkAfter && autoAfter && !existing.nextAutoMessageAt) {
            patch['nextAutoMessageAt'] = new Date()
          }
          if (!autoAfter) patch['nextAutoMessageAt'] = null
          await ctx.db.directDebitCase.update({ where: { id: existing.id }, data: patch })
          await ctx.audit({
            action: 'direct_debit.case_chase_updated',
            target: { type: 'DirectDebitCase', id: existing.id },
            after: { ...input },
          })
          return { ok: true }
        }),

      /** The manual "they're up to date" tick — closes the case and stops all
       *  automated messages immediately (ADR 0045). */
      markUpToDate: protectedProcedure
        .input(z.object({ caseId: z.string().min(1), note: z.string().max(1000).nullish() }))
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const existing = await ctx.db.directDebitCase.findFirst({
            where: { id: input.caseId, deletedAt: null },
            select: { id: true, contactId: true, status: true },
          })
          if (!existing) throw new TRPCError({ code: 'NOT_FOUND' })
          await ctx.db.directDebitCase.update({
            where: { id: existing.id },
            data: {
              status: 'recovered',
              recoveredAt: new Date(),
              recoveryMethod: 'manual',
              recoveryRef: input.note ?? null,
              autoChase: false,
              nextAutoMessageAt: null,
              updatedById: user.id,
            },
          })
          if (existing.contactId) {
            await ctx.db.interaction.create({
              data: {
                id: createId(),
                type: 'note',
                contactId: existing.contactId,
                occurredAt: new Date(),
                summary: 'Marked up to date — Direct Debit chasing stopped',
                payload: {
                  event: 'direct_debit.case_marked_up_to_date',
                  caseId: existing.id,
                  note: input.note ?? null,
                  authorId: user.id,
                },
                createdById: user.id,
              },
            })
          }
          await ctx.audit({
            action: 'direct_debit.case_marked_up_to_date',
            target: { type: 'DirectDebitCase', id: existing.id },
            after: { note: input.note ?? null },
          })
          return { ok: true }
        }),

      /** Per-case automated message history — what went out, when, how serious. */
      chaseMessages: protectedProcedure
        .input(z.object({ caseId: z.string().min(1) }))
        .query(async ({ ctx, input }) => {
          requireUser(ctx)
          return ctx.db.ddCaseMessage.findMany({
            where: { caseId: input.caseId },
            orderBy: { createdAt: 'desc' },
            take: 50,
            select: {
              id: true,
              channel: true,
              step: true,
              toAddress: true,
              subject: true,
              body: true,
              status: true,
              error: true,
              createdAt: true,
            },
          })
        }),

      /** Full detail for one recovery case — identity, chase settings, owner and
       *  the complete communication history — for the collections detail view
       *  (ADR 0045 amendment). Works for standalone (no contact) cases. */
      caseDetail: protectedProcedure
        .input(z.object({ caseId: z.string().min(1) }))
        .query(async ({ ctx, input }) => {
          requireUser(ctx)
          const c = await ctx.db.directDebitCase.findFirst({
            where: { id: input.caseId, deletedAt: null },
            include: {
              messages: { orderBy: { createdAt: 'desc' }, take: 100 },
            },
          })
          if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
          const contact = c.contactId
            ? await ctx.db.contact.findUnique({
                where: { id: c.contactId },
                select: { id: true, firstName: true, lastName: true, email: true, phoneE164: true },
              })
            : null
          const owner = c.ownerUserId
            ? await ctx.db.user.findUnique({
                where: { id: c.ownerUserId },
                select: { id: true, name: true, email: true },
              })
            : null
          const contactName = contact
            ? [contact.firstName, contact.lastName].filter(Boolean).join(' ') || null
            : null
          const outstandingMinor = Math.max(0, c.openingShortfallMinor - c.recoveredMinor)
          const recoverySettings = await loadDdRecoverySettings(ctx.db)
          // The token values (name, amount, re-signup link, calculated CCJ
          // court fee + statutory interest) the send preview renders with — the
          // SAME set the automated engine uses, so the customer sees one figure.
          const { vars, ccj } = buildCaseRecoveryVars(
            {
              personName: c.personName,
              contactFirstName: contact?.firstName ?? null,
              contactLastName: contact?.lastName ?? null,
              outstandingMinor,
              setupLinkUrl: c.setupLinkUrl,
              createdAt: c.createdAt,
            },
            new Date(),
            recoverySettings,
          )
          return {
            id: c.id,
            status: c.status,
            contactId: c.contactId,
            gcCustomerId: c.gcCustomerId,
            gcSubscriptionId: c.gcSubscriptionId,
            name: contactName || c.personName || c.chaseEmail || c.chasePhoneE164 || 'Unknown',
            personName: c.personName,
            chaseEmail: c.chaseEmail ?? contact?.email ?? null,
            chasePhoneE164: c.chasePhoneE164 ?? contact?.phoneE164 ?? null,
            outstandingMinor,
            openingShortfallMinor: c.openingShortfallMinor,
            recoveredMinor: c.recoveredMinor,
            autoChase: c.autoChase,
            sendEmails: c.sendEmails,
            sendTexts: c.sendTexts,
            setupLinkUrl: c.setupLinkUrl,
            cadenceDays: c.cadenceDays,
            escalationStep: c.escalationStep,
            lastAutoMessageAt: c.lastAutoMessageAt,
            nextAutoMessageAt: c.nextAutoMessageAt,
            ownerUserId: c.ownerUserId,
            ownerName: owner?.name ?? owner?.email ?? null,
            notes: c.notes,
            recoveredAt: c.recoveredAt,
            recoveryMethod: c.recoveryMethod,
            createdAt: c.createdAt,
            // Token values for the send preview + a CCJ breakdown for the agent.
            templateVars: vars,
            ccj: {
              courtFeeMinor: ccj.courtFeeMinor,
              interestMinor: ccj.interestMinor,
              lateFeeMinor: ccj.lateFeeMinor,
              totalMinor: ccj.totalMinor,
              daysOverdue: ccj.daysOverdue,
            },
            messages: c.messages.map((m) => ({
              id: m.id,
              channel: m.channel,
              step: m.step,
              toAddress: m.toAddress,
              subject: m.subject,
              body: m.body,
              status: m.status,
              error: m.error,
              createdAt: m.createdAt,
            })),
          }
        }),

      /** Send a human-confirmed manual recovery message from a case by caseId
       *  (ADR 0045 amendment) — the collections-CRM path that also works for a
       *  STANDALONE person (no CRM contact). The agent has already reviewed the
       *  final subject/body; this sends it (email via system Gmail, SMS via
       *  Trengo under the agent's own token, §11), optionally attaches the
       *  chosen template's PDF, records it in the case history (DdCaseMessage)
       *  and — when a contact is linked — on their timeline. CLAUDE.md §3, §14. */
      sendCaseMessage: protectedProcedure
        .input(
          z.object({
            caseId: z.string().min(1),
            channel: z.enum(['email', 'sms']),
            templateId: z.string().nullish(),
            subject: z.string().trim().max(300).optional(),
            body: z.string().trim().min(1).max(10_000),
            /** Attach the chosen template's PDF (email only). Default on. */
            includePdf: z.boolean().default(true),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const c = await ctx.db.directDebitCase.findFirst({
            where: { id: input.caseId, deletedAt: null },
          })
          if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
          const contact = c.contactId
            ? await ctx.db.contact.findUnique({
                where: { id: c.contactId },
                select: { id: true, email: true, phoneE164: true },
              })
            : null

          let status: 'sent' | 'failed' = 'sent'
          let error: string | null = null
          let toAddress = ''

          if (input.channel === 'email') {
            const to = (c.chaseEmail ?? contact?.email ?? '').trim()
            if (!to) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'No email address on this case — add one first.',
              })
            }
            const subject = input.subject?.trim()
            if (!subject) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'A subject is required.' })
            }
            toAddress = to
            const attachments: Array<{ filename: string; content: Buffer; contentType?: string }> =
              []
            const tpl = input.templateId
              ? await ctx.db.ddRecoveryTemplate.findUnique({
                  where: { id: input.templateId },
                  select: { kind: true, pdfData: true, pdfFileName: true, pdfContentType: true },
                })
              : null
            if (input.includePdf) {
              // A PDF copy of the letter (from the final edited body) for the
              // serious steps; and any fixed document staff attached.
              if (tpl?.kind === 'legal_escalation') {
                const letterhead = companyLetterhead(await loadDdRecoverySettings(ctx.db))
                attachments.push({
                  filename: 'letter.pdf',
                  content: renderRecoveryLetterPdf({ subject, body: input.body, ...letterhead }),
                  contentType: 'application/pdf',
                })
              }
              if (tpl?.pdfData) {
                attachments.push({
                  filename: tpl.pdfFileName ?? 'document.pdf',
                  content: Buffer.from(tpl.pdfData),
                  contentType: tpl.pdfContentType ?? 'application/pdf',
                })
              }
            }
            const result = await sendSystemEmail({
              to,
              subject,
              text: input.body,
              requestId: ctx.requestId,
              ...(attachments.length > 0 ? { attachments } : {}),
            })
            if (result.status !== 'sent') {
              status = 'failed'
              error =
                result.detail ??
                (result.status === 'skipped'
                  ? 'No system mailbox connected — connect Gmail in Settings.'
                  : 'The email could not be sent.')
            } else if (contact) {
              // Reflect on the linked customer's timeline.
              await ctx.db.interaction.create({
                data: {
                  id: createId(),
                  type: 'email_sent',
                  contactId: contact.id,
                  occurredAt: new Date(),
                  summary: `Direct Debit recovery email: ${subject}`.slice(0, 140),
                  payload: {
                    kind: 'dd_recovery',
                    subject,
                    body: input.body,
                    to,
                    caseId: c.id,
                    templateId: input.templateId ?? null,
                    gmailId: result.id,
                    authorId: user.id,
                  },
                  createdById: user.id,
                  updatedById: user.id,
                },
              })
            }
          } else {
            // SMS via Trengo.
            const phone = (c.chasePhoneE164 ?? contact?.phoneE164 ?? '').trim()
            if (!phone || !phone.startsWith('+')) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'No usable phone number on this case for SMS.',
              })
            }
            toAddress = phone
            try {
              if (contact) {
                // Linked contact → reflect on their timeline (existing thread or
                // a new one). The Trengo outbound writes its own Interaction.
                const { resolveActiveTrengoConversation } = await import(
                  '@studymind/integration-trengo/conversations'
                )
                const { sendMessage, startConversation } = await import(
                  '@studymind/integration-trengo/outbound'
                )
                const conv = await resolveActiveTrengoConversation(ctx.db, contact.id, 'sms')
                if (conv) {
                  await sendMessage({
                    contactId: contact.id,
                    agentId: user.id,
                    ticketId: conv.ticketId,
                    channel: 'sms',
                    body: input.body,
                    requestId: ctx.requestId,
                  })
                } else {
                  await startConversation({
                    contactId: contact.id,
                    agentId: user.id,
                    channel: 'sms',
                    recipient: phone,
                    body: input.body,
                    requestId: ctx.requestId,
                  })
                }
              } else {
                // Standalone person — raw send, the DdCaseMessage below is the record.
                const { sendStandaloneMessage } = await import(
                  '@studymind/integration-trengo/outbound'
                )
                await sendStandaloneMessage({
                  agentId: user.id,
                  channel: 'sms',
                  recipient: phone,
                  body: input.body,
                  requestId: ctx.requestId,
                  auditTarget: { type: 'DirectDebitCase', id: c.id },
                })
              }
            } catch (err) {
              status = 'failed'
              error = err instanceof Error ? err.message : 'send failed'
            }
          }

          // Record on the case history (auto + manual sends share this log).
          await ctx.db.ddCaseMessage.create({
            data: {
              id: createId(),
              caseId: c.id,
              channel: input.channel,
              templateId: input.templateId ?? null,
              step: c.escalationStep,
              toAddress,
              subject: input.channel === 'email' ? (input.subject?.trim() ?? null) : null,
              body: input.body,
              status,
              error,
            },
          })

          if (status === 'failed') {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: error ?? 'The message could not be sent.',
            })
          }

          // Nudge a brand-new case into `chasing` once the first message goes out.
          if (c.status === 'new') {
            await ctx.db.directDebitCase.update({
              where: { id: c.id },
              data: { status: 'chasing', updatedById: user.id },
            })
          }

          await ctx.audit({
            action: 'direct_debit.recovery_sent',
            target: { type: 'DirectDebitCase', id: c.id },
            after: { channel: input.channel, to: toAddress, manual: true },
          })
          return { status: 'sent' as const }
        }),

      /** Optional "refine with AI" (ADR 0045 amendment, §3/§18): lightly
       *  personalises an already-filled recovery draft for this customer while
       *  keeping every figure, link, date and legal statement verbatim. The
       *  agent reviews + edits + sends — nothing sends from here. */
      draftMessage: protectedProcedure
        .input(
          z.object({
            caseId: z.string().min(1),
            channel: z.enum(['email', 'sms']),
            body: z.string().trim().min(1).max(10_000),
          }),
        )
        .mutation(async ({ ctx, input }) => {
          const user = requireUser(ctx)
          assertFinanceRole(user)
          const c = await ctx.db.directDebitCase.findFirst({
            where: { id: input.caseId, deletedAt: null },
            select: { id: true, contactId: true, personName: true },
          })
          if (!c) throw new TRPCError({ code: 'NOT_FOUND' })
          const contact = c.contactId
            ? await ctx.db.contact.findUnique({
                where: { id: c.contactId },
                select: { firstName: true },
              })
            : null
          const { buildDdRecoveryDraftPrompt, ddRecoveryDraftShape, DD_RECOVERY_DRAFT_PROMPT_VERSION } =
            await import('@studymind/ai')
          const { runDraft } = await import('@studymind/ai')
          const firstName =
            contact?.firstName ?? (c.personName ? c.personName.split(/\s+/u)[0] : null) ?? null
          const prompt = buildDdRecoveryDraftPrompt({
            channel: input.channel,
            draft: input.body,
            firstName,
          })
          const result = await runDraft({
            task: 'dd_recovery_draft',
            promptVersion: prompt.promptVersion,
            system: prompt.system,
            user: prompt.user,
            model: 'gpt-4o',
            contentShape: ddRecoveryDraftShape(input.channel),
            contactId: c.contactId ?? undefined,
            ctx: { caseId: c.id, agentId: user.id },
          })
          await ctx.audit({
            action: 'ai.draft_generated',
            target: { type: 'DirectDebitCase', id: c.id },
            purpose: 'dd-recovery-draft',
            after: {
              channel: input.channel,
              promptVersion: DD_RECOVERY_DRAFT_PROMPT_VERSION,
              length: result.text.length,
            },
          })
          return { text: result.text }
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
            channel: z.enum(['email', 'sms']).default('email'),
            templateId: z.string().nullish(),
            subject: z.string().trim().max(300).optional(),
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
            select: { id: true, email: true, phoneE164: true },
          })
          if (!contact) throw new TRPCError({ code: 'NOT_FOUND', message: 'contact not found' })

          if (input.channel === 'email') {
            if (!contact.email) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'This contact has no email address — add one before sending.',
              })
            }
            const subject = input.subject?.trim()
            if (!subject) {
              throw new TRPCError({ code: 'BAD_REQUEST', message: 'A subject is required.' })
            }
            const result = await sendSystemEmail({
              to: contact.email,
              subject,
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
                summary: `Direct Debit recovery email: ${subject}`.slice(0, 140),
                payload: {
                  kind: 'dd_recovery',
                  subject,
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
          } else {
            // SMS via Trengo — continue the contact's active SMS thread, else
            // start a new one to their E.164 number. The Trengo outbound logs
            // its own `message` Interaction (pending_send → delivered), so the
            // send already reflects on the customer's timeline.
            const phone = contact.phoneE164?.trim()
            if (!phone || !phone.startsWith('+')) {
              throw new TRPCError({
                code: 'BAD_REQUEST',
                message: 'This contact has no usable phone number for SMS.',
              })
            }
            const { resolveActiveTrengoConversation } = await import(
              '@studymind/integration-trengo/conversations'
            )
            const { sendMessage, startConversation } = await import(
              '@studymind/integration-trengo/outbound'
            )
            const conv = await resolveActiveTrengoConversation(ctx.db, contact.id, 'sms')
            if (conv) {
              await sendMessage({
                contactId: contact.id,
                agentId: user.id,
                ticketId: conv.ticketId,
                channel: 'sms',
                body: input.body,
                requestId: ctx.requestId,
              })
            } else {
              await startConversation({
                contactId: contact.id,
                agentId: user.id,
                channel: 'sms',
                recipient: phone,
                body: input.body,
                requestId: ctx.requestId,
              })
            }
          }

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
            after: {
              channel: input.channel,
              to: input.channel === 'email' ? contact.email : contact.phoneE164,
            },
          })
          return { status: 'sent' as const }
        }),
    }),
  }),

  refund: router({
    create: auditedProcedure.input(RefundCreateInput).mutation(async ({ ctx, input }) => {
      const user = requireUser(ctx)
      assertCanRefund(user)
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
      assertCanRefund(requireUser(ctx))
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
